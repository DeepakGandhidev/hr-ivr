-- Per-job interview settings.
--
-- Length and difficulty used to be fixed in the interviewer's prompt ("six to
-- ten questions"), identical for a fresher QA role and a staff engineer, and
-- nothing bounded how long a call could run.

CREATE TYPE "InterviewDifficulty" AS ENUM ('easy', 'moderate', 'hard', 'expert');

ALTER TABLE "interview_protocols"
  ADD COLUMN "duration_minutes" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "difficulty"       "InterviewDifficulty" NOT NULL DEFAULT 'moderate',
  ADD COLUMN "min_questions"    INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "max_questions"    INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "focus_areas"      JSONB,
  -- What the agent calls itself and the company on the call. Null falls back to
  -- the tenant's own name.
  ADD COLUMN "agent_name"       TEXT,
  ADD COLUMN "company_name"     TEXT;

-- A max below the min would make the wrap-up instruction contradict itself.
ALTER TABLE "interview_protocols"
  ADD CONSTRAINT "interview_protocols_question_range_check"
  CHECK ("min_questions" >= 1 AND "max_questions" >= "min_questions" AND "max_questions" <= 40);

ALTER TABLE "interview_protocols"
  ADD CONSTRAINT "interview_protocols_duration_check"
  CHECK ("duration_minutes" >= 2 AND "duration_minutes" <= 90);
