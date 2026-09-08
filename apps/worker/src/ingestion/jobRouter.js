/**
 * Work out which open job an application is for.
 *
 * This is what lets one mailbox serve every role. Without it a mailbox files
 * everything against a single job, so a QA application lands in the MERN
 * pipeline and a recruiter has to re-file it by hand.
 *
 * Matching is deliberately literal — token overlap against job titles, not a
 * language model. A recruiter has to be able to look at a misfiled candidate
 * and see exactly why it went there, and a wrong-but-explainable match is
 * cheaper to correct than a confident invisible one.
 */

/** Words that appear in most job titles and so carry no signal. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'at', 'on', 'with',
  'job', 'jobs', 'role', 'roles', 'position', 'positions', 'vacancy', 'opening',
  'openings', 'application', 'applying', 'apply', 'resume', 'cv', 'candidate',
  'profile', 'hiring', 'career', 'careers', 'post', 'posts', 'req', 'requirement',
  // Seniority is a poor discriminator: most titles carry one, and applicants
  // rarely repeat it accurately.
  'senior', 'junior', 'lead', 'sr', 'jr', 'mid', 'level', 'i', 'ii', 'iii',
]);

/** Score at which a match is trusted over the fallback bucket. */
export const MATCH_THRESHOLD = 45;

function tokenise(text) {
  return String(text ?? '')
    .toLowerCase()
    // Keep + and # so "c++" and "c#" survive; they are the whole signal in
    // some titles.
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Distinctive tokens for a job, from its title and slug. */
function jobTokens(job) {
  return new Set([...tokenise(job.title), ...tokenise(String(job.slug ?? '').replace(/-/g, ' '))]);
}

/**
 * Score one job against one message.
 *
 * The subject is weighted far above the body: "Application for QA Engineer" is
 * a statement of intent, whereas the same words inside a CV are just skills
 * history — nearly every backend CV mentions QA, testing and design somewhere.
 */
function scoreJob(job, subject, body) {
  const tokens = jobTokens(job);
  if (tokens.size === 0) return 0;

  const subjectTokens = new Set(tokenise(subject));
  const bodyTokens = new Set(tokenise(body));

  let matchedInSubject = 0;
  let matchedInBody = 0;
  for (const token of tokens) {
    if (subjectTokens.has(token)) matchedInSubject += 1;
    else if (bodyTokens.has(token)) matchedInBody += 1;
  }

  if (matchedInSubject === 0 && matchedInBody === 0) return 0;

  const coverage = matchedInSubject / tokens.size;
  let score = Math.round(coverage * 70);

  // The full title appearing verbatim is as unambiguous as it gets.
  const title = String(job.title ?? '').toLowerCase().trim();
  if (title && String(subject ?? '').toLowerCase().includes(title)) score += 30;

  // Body matches break ties but never carry a match on their own.
  score += Math.min(matchedInBody, 3) * 4;

  return Math.min(score, 100);
}

/**
 * @param {{subject?: string, text?: string, cvText?: string}} message
 * @param {Array<{id: string, title: string, slug?: string}>} jobs  open jobs only
 * @returns {{jobId: string|null, confidence: number, matchedTitle: string|null,
 *   runnerUp: string|null}}
 */
export function matchJobFromMessage(message, jobs = []) {
  const none = { jobId: null, confidence: 0, matchedTitle: null, runnerUp: null };
  if (!Array.isArray(jobs) || jobs.length === 0) return none;

  const subject = message.subject ?? '';
  // CV text is included but the subject still dominates the weighting above.
  const body = [message.text ?? '', message.cvText ?? ''].join('\n').slice(0, 4000);

  const ranked = jobs
    .map((job) => ({ job, score: scoreJob(job, subject, body) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score === 0) return none;

  // Below the threshold the application still goes to the fallback bucket, but
  // the near miss is reported so "why did this not match?" is answerable from
  // the log instead of by re-running the router by hand.
  if (best.score < MATCH_THRESHOLD) {
    return { ...none, runnerUp: best.job.title };
  }

  // Two jobs scoring the same means the message did not actually distinguish
  // them ("Developer" against both "Frontend Developer" and "Backend
  // Developer"). Guessing between them is worse than the fallback bucket,
  // where a human decides.
  const second = ranked[1];
  if (second && second.score === best.score) {
    return { ...none, runnerUp: second.job.title };
  }

  return {
    jobId: best.job.id,
    confidence: best.score,
    matchedTitle: best.job.title,
    runnerUp: second && second.score >= MATCH_THRESHOLD ? second.job.title : null,
  };
}
