import { describe, it, expect } from 'vitest';
import { matchJobFromMessage, MATCH_THRESHOLD } from '../src/ingestion/jobRouter.js';

// The roles this tenant actually has open.
const JOBS = [
  { id: 'j-mern', title: 'MERN Stack Developer', slug: 'mern-stack-developer' },
  { id: 'j-qa', title: 'QA Engineer', slug: 'qa-engineer' },
  { id: 'j-seo', title: 'SEO / AEO Specialist', slug: 'seo-aeo-specialist' },
  { id: 'j-uiux', title: 'UI/UX Designer', slug: 'ui-ux-designer' },
  { id: 'j-sales', title: 'Sales Executive', slug: 'sales-executive' },
];

const msg = (subject, text = '') => ({ subject, text });

describe('routing an application to the right job', () => {
  it('matches the exact title in the subject', () => {
    const match = matchJobFromMessage(msg('Application for MERN Stack Developer'), JOBS);
    expect(match.jobId).toBe('j-mern');
    expect(match.confidence).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });

  it('matches when the applicant abbreviates the title', () => {
    expect(matchJobFromMessage(msg('Applying for QA Engineer role'), JOBS).jobId).toBe('j-qa');
    expect(matchJobFromMessage(msg('Resume for SEO Specialist'), JOBS).jobId).toBe('j-seo');
  });

  it('ignores seniority words, which applicants get wrong', () => {
    expect(matchJobFromMessage(msg('Senior QA Engineer application'), JOBS).jobId).toBe('j-qa');
  });

  it('matches a slug-style subject from a job board', () => {
    expect(matchJobFromMessage(msg('ui-ux-designer'), JOBS).jobId).toBe('j-uiux');
  });

  it('is case and punctuation insensitive', () => {
    expect(matchJobFromMessage(msg('APPLICATION — SALES EXECUTIVE!!'), JOBS).jobId).toBe('j-sales');
  });
});

describe('refuses to guess', () => {
  // The whole point of the fallback bucket. A wrong-but-confident match is
  // worse than one a human has to file, because nobody ever revisits it.
  it('returns no match for a subject that names no role', () => {
    const match = matchJobFromMessage(msg('Job application', 'Please find my CV attached.'), JOBS);
    expect(match.jobId).toBeNull();
  });

  it('returns no match when two jobs are equally plausible', () => {
    const jobs = [
      { id: 'j-fe', title: 'Frontend Developer', slug: 'frontend-developer' },
      { id: 'j-be', title: 'Backend Developer', slug: 'backend-developer' },
    ];
    const match = matchJobFromMessage(msg('Application for Developer'), jobs);

    expect(match.jobId).toBeNull();
    expect(match.runnerUp).toBeTruthy();
  });

  it('does not match on CV body text alone', () => {
    // Nearly every backend CV mentions QA and testing somewhere; that must not
    // pull the application into the QA pipeline.
    const match = matchJobFromMessage(
      msg('My application', 'Worked closely with QA and wrote engineer-level test plans.'),
      JOBS
    );
    expect(match.jobId).toBeNull();
  });

  it('returns no match when the tenant has no open jobs', () => {
    expect(matchJobFromMessage(msg('MERN Stack Developer'), []).jobId).toBeNull();
  });

  it('survives a missing subject', () => {
    expect(matchJobFromMessage({ text: 'hello' }, JOBS).jobId).toBeNull();
    expect(matchJobFromMessage({}, JOBS).jobId).toBeNull();
  });
});

describe('body text refines a partial subject match', () => {
  const ADS = [{ id: 'j-ads', title: 'Performance Marketing Manager', slug: 'performance-marketing-manager' }];

  // A subject naming the full title already scores the maximum, so the body
  // can only matter where the subject was partial — which is the common case.
  it('raises confidence when the body supplies the missing title word', () => {
    const weak = matchJobFromMessage(msg('Application for Marketing Manager'), ADS);
    const strong = matchJobFromMessage(
      msg('Application for Marketing Manager', 'Six years of performance marketing on Google and Meta.'),
      ADS
    );

    expect(weak.jobId).toBe('j-ads');
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
  });

  it('caps out when the subject already names the exact title', () => {
    const withBody = matchJobFromMessage(msg('Performance Marketing Manager', 'anything'), ADS);
    expect(withBody.confidence).toBe(100);
  });
});
