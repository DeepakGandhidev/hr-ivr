-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('trial', 'active', 'suspended');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'admin', 'reviewer', 'viewer');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('gmail', 'outlook', 'imap', 'forward_alias');

-- CreateEnum
CREATE TYPE "EmailConnectionStatus" AS ENUM ('connected', 'error', 'revoked');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('draft', 'open', 'paused', 'closed');

-- CreateEnum
CREATE TYPE "DescriptionGeneratedBy" AS ENUM ('ai', 'human');

-- CreateEnum
CREATE TYPE "JobPostChannel" AS ENUM ('careers_page', 'linkedin', 'naukri', 'manual');

-- CreateEnum
CREATE TYPE "JobPostStatus" AS ENUM ('pending', 'posted', 'failed', 'removed');

-- CreateEnum
CREATE TYPE "ScreeningVerdict" AS ENUM ('shortlist', 'archive');

-- CreateEnum
CREATE TYPE "ShortlistStatus" AS ENUM ('draft', 'awaiting_approval', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "ShortlistItemFinalState" AS ENUM ('approved', 'removed');

-- CreateEnum
CREATE TYPE "OutreachTemplateType" AS ENUM ('interview_invite', 'rejection', 'reminder');

-- CreateEnum
CREATE TYPE "OutreachEmailStatus" AS ENUM ('sent', 'bounced', 'failed');

-- CreateEnum
CREATE TYPE "InterviewLanguage" AS ENUM ('en', 'hi', 'hinglish');

-- CreateEnum
CREATE TYPE "InterviewCallStatus" AS ENUM ('completed', 'dropped', 'no_show', 'unknown_caller', 'out_of_window', 'declined_consent');

-- CreateEnum
CREATE TYPE "Recommendation" AS ENUM ('strong_yes', 'yes', 'maybe', 'no');

-- CreateEnum
CREATE TYPE "PromptTemplateKey" AS ENUM ('jd_generation', 'cv_screening', 'interviewer_system', 'report_generation');

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_inr" INTEGER NOT NULL,
    "limits" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "auth_provider_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "trial_ends_at" TIMESTAMP(3),
    "status" "TenantStatus" NOT NULL DEFAULT 'trial',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL,
    "auth_provider_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "EmailProvider" NOT NULL,
    "address" TEXT NOT NULL,
    "oauth_token_ref" TEXT,
    "status" "EmailConnectionStatus" NOT NULL DEFAULT 'connected',
    "last_poll_at" TIMESTAMP(3),
    "error_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'draft',
    "location" TEXT,
    "salary_band" TEXT,
    "experience_range" TEXT,
    "must_haves" JSONB NOT NULL,
    "good_to_haves" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_descriptions" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body_md" TEXT NOT NULL,
    "generated_by" "DescriptionGeneratedBy" NOT NULL DEFAULT 'human',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_descriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_posts" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "channel" "JobPostChannel" NOT NULL,
    "status" "JobPostStatus" NOT NULL DEFAULT 'pending',
    "external_ref" TEXT,
    "posted_at" TIMESTAMP(3),
    "includes_pratibha_number" BOOLEAN NOT NULL DEFAULT true,
    "error_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "cv_file_ref" TEXT,
    "cv_parsed" JSONB,
    "source_email_msg_id" TEXT,
    "parse_failed" BOOLEAN NOT NULL DEFAULT false,
    "no_phone" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screenings" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "matched_must_haves" JSONB NOT NULL,
    "gaps" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "tokens_in" INTEGER NOT NULL,
    "tokens_out" INTEGER NOT NULL,
    "cost_usd" DOUBLE PRECISION NOT NULL,
    "verdict" "ScreeningVerdict" NOT NULL,
    "reason_summary" TEXT NOT NULL,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screenings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shortlists" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "status" "ShortlistStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shortlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shortlist_items" (
    "id" TEXT NOT NULL,
    "shortlist_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "removed_by" TEXT,
    "final_state" "ShortlistItemFinalState",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shortlist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "shortlist_id" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB NOT NULL,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_templates" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" "OutreachTemplateType" NOT NULL,
    "subject" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_emails" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "rendered_body" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "status" "OutreachEmailStatus",
    "approval_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_windows" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "days" JSONB NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_protocols" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "job_id" TEXT,
    "instruction_text" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_protocols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_calls" (
    "id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "caller_number" TEXT NOT NULL,
    "recognised" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "language" "InterviewLanguage",
    "status" "InterviewCallStatus",
    "recording_ref" TEXT,
    "transcript_ref" TEXT,
    "telephony_cost" DOUBLE PRECISION,
    "llm_cost_usd" DOUBLE PRECISION,
    "tts_cost_usd" DOUBLE PRECISION,
    "stt_cost_usd" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_reports" (
    "id" TEXT NOT NULL,
    "interview_call_id" TEXT NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "recommendation" "Recommendation" NOT NULL,
    "dimensions" JSONB NOT NULL,
    "strengths" TEXT[],
    "concerns" TEXT[],
    "notable_quotes" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_meters" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "interviews_used" INTEGER NOT NULL DEFAULT 0,
    "screenings_used" INTEGER NOT NULL DEFAULT 0,
    "overage_interviews" INTEGER NOT NULL DEFAULT 0,
    "overage_screenings" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_meters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" TEXT NOT NULL,
    "key" "PromptTemplateKey" NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plans_name_key" ON "plans"("name");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_email_key" ON "platform_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_users_auth_provider_id_key" ON "platform_users"("auth_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_provider_id_key" ON "users"("auth_provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_tenant_id_slug_key" ON "jobs"("tenant_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "job_descriptions_job_id_version_key" ON "job_descriptions"("job_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_source_email_msg_id_key" ON "candidates"("source_email_msg_id");

-- CreateIndex
CREATE INDEX "candidates_tenant_id_phone_e164_idx" ON "candidates"("tenant_id", "phone_e164");

-- CreateIndex
CREATE INDEX "candidates_tenant_id_job_id_email_idx" ON "candidates"("tenant_id", "job_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_tenant_id_job_id_phone_e164_key" ON "candidates"("tenant_id", "job_id", "phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "shortlist_items_shortlist_id_candidate_id_key" ON "shortlist_items"("shortlist_id", "candidate_id");

-- CreateIndex
CREATE INDEX "outreach_emails_approval_id_candidate_id_idx" ON "outreach_emails"("approval_id", "candidate_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_protocols_tenant_id_job_id_key" ON "interview_protocols"("tenant_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_reports_interview_call_id_key" ON "assessment_reports"("interview_call_id");

-- CreateIndex
CREATE UNIQUE INDEX "usage_meters_tenant_id_period_key" ON "usage_meters"("tenant_id", "period");

-- CreateIndex
CREATE INDEX "prompt_templates_key_active_idx" ON "prompt_templates"("key", "active");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_templates_key_version_key" ON "prompt_templates"("key", "version");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_entity_idx" ON "audit_logs"("action", "entity");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_descriptions" ADD CONSTRAINT "job_descriptions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_descriptions" ADD CONSTRAINT "job_descriptions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_posts" ADD CONSTRAINT "job_posts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "screenings" ADD CONSTRAINT "screenings_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortlists" ADD CONSTRAINT "shortlists_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_shortlist_id_fkey" FOREIGN KEY ("shortlist_id") REFERENCES "shortlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shortlist_items" ADD CONSTRAINT "shortlist_items_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_shortlist_id_fkey" FOREIGN KEY ("shortlist_id") REFERENCES "shortlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_templates" ADD CONSTRAINT "outreach_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_templates" ADD CONSTRAINT "outreach_templates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_emails" ADD CONSTRAINT "outreach_emails_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_emails" ADD CONSTRAINT "outreach_emails_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "outreach_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_emails" ADD CONSTRAINT "outreach_emails_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_windows" ADD CONSTRAINT "call_windows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_protocols" ADD CONSTRAINT "interview_protocols_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_protocols" ADD CONSTRAINT "interview_protocols_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_protocols" ADD CONSTRAINT "interview_protocols_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_calls" ADD CONSTRAINT "interview_calls_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_reports" ADD CONSTRAINT "assessment_reports_interview_call_id_fkey" FOREIGN KEY ("interview_call_id") REFERENCES "interview_calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_meters" ADD CONSTRAINT "usage_meters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
