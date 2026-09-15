-- AlterTable
--
-- The four report sections the recruiter reads.
--
-- Two scores, kept separate on purpose. `interview_score` is how the
-- conversation went; `recommendation_score` is the verdict across the JD, the CV
-- screening and the interview together. They can legitimately disagree - a
-- candidate can interview well and screen badly - and one column could not say
-- so.
ALTER TABLE "assessment_reports"
  ADD COLUMN "interview_score" DOUBLE PRECISION,
  ADD COLUMN "interview_score_reasoning" TEXT,
  ADD COLUMN "question_answers" JSONB,
  ADD COLUMN "jd_fit_summary" TEXT,
  ADD COLUMN "recommendation_score" DOUBLE PRECISION,
  ADD COLUMN "recommendation_verdict" TEXT;

-- --------------------------------------------------------------------------
-- Backfill the interview score from what already exists.
--
-- `overall_score` has always been the mean of the per-criterion scores from the
-- interview, so it is the interview score under an older name. Copying it means
-- existing reports open with section 1 populated instead of blank.
--
-- `recommendation_score` is deliberately NOT backfilled. Nothing on record ever
-- combined screening and interview, so any value here would be invented - and a
-- made-up verdict score is worse than an absent one. Existing reports show it as
-- unavailable until they are regenerated.
-- --------------------------------------------------------------------------
UPDATE assessment_reports
SET interview_score = overall_score
WHERE interview_score IS NULL;

-- --------------------------------------------------------------------------
-- Version 2 of the report prompt.
--
-- Kept in the database with the existing template rather than hardcoded, so the
-- wording can be iterated without a deploy. The previous version is deactivated
-- rather than deleted: reports already generated were produced by it, and
-- knowing which prompt wrote a given report is the only way to interpret a
-- sudden change in how scores read.
-- --------------------------------------------------------------------------
UPDATE prompt_templates SET active = false WHERE key = 'report_generation';

INSERT INTO prompt_templates (id, key, version, body, active, created_at)
SELECT
  'pt_report_v2',
  'report_generation',
  COALESCE(MAX(version), 0) + 1,
  $prompt$You are assessing a completed first-round screening call for {{tenantName}}.
You are given the job and its requirements, the candidate's CV summary, the screening criteria, and the full transcript.

Score each criterion from 1 to 5 on the evidence in the transcript.

RULES
- Every criterion score must quote the candidate verbatim from the transcript as its evidence. Copy the words exactly as they appear - do not paraphrase, tidy, or join separate remarks together.
- If a criterion was never reached, or the candidate said nothing that bears on it, do not score it. Report it under not_assessed instead. A guessed score is worse than an absent one.
- Judge only skills, experience and demonstrated work. Never take account of the candidate's name, gender, age, marital status, religion, caste, region of origin, or which institution they attended. Institutional prestige is not evidence of anything.
- Note where demonstrated depth does not match what the CV claims, in either direction.
- You are making a recommendation for a human to act on. You are not deciding anything, and you cannot reject anyone.

THE TWO SCORES ARE DIFFERENT AND MAY DISAGREE
- interview_score (0-10) judges the interview ONLY: how well this person answered the questions actually put to them. A strong interview earns a high score here even if their CV is thin for the role.
- recommendation_score (0-10) is the verdict on the whole picture: the role's requirements, what the CV screening found, and the interview together. A candidate who interviews well but does not meet the role's requirements should score high on the first and low on this one.
- Do not make them agree out of tidiness. Where they differ, interview_score_reasoning and recommendation_verdict should each say why.

WRITING THE REASONING
- interview_score_reasoning: explain the interview score so a hiring manager can check it. Refer to what the candidate actually said. Several sentences, not a label.
- jd_fit_summary: address THIS role's stated requirements one by one - which are met, which are not, and on what evidence. Generic praise is worthless here.
- recommendation_verdict: a short, direct verdict a busy reader can act on, consistent with recommendation_score.$prompt$,
  true,
  NOW()
FROM prompt_templates WHERE key = 'report_generation';
