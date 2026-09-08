import { MAX_CV_FILE_BYTES, ValidationError } from "@pratibha/shared";
import { upsertCandidate } from "@pratibha/worker/src/ingestion/createCandidate.js";
import { normalizePhoneE164, parseCvText } from "@pratibha/worker/src/ingestion/parser.js";
import type { TenantTransactionClient } from "@/lib/authz";

/**
 * Adding CVs to a job from the app, rather than waiting for the mailbox poller
 * to find them.
 *
 * The parsing, dedupe and merge rules are the worker's — imported, not
 * reimplemented. A CV a recruiter drags in and the same CV arriving by mail an
 * hour later must produce one candidate, and they only do that if both paths
 * ask the same code who this person is.
 */

export interface IngestFileResult {
  filename: string;
  status: "created" | "merged" | "failed";
  candidateId?: string;
  name?: string | null;
  email?: string | null;
  phoneE164?: string | null;
  /** True when the file was read but yielded nothing usable — a scan, usually. */
  parseFailed?: boolean;
  /** Why extraction produced no text, when it did not. */
  reason?: string | null;
  needsOcr?: boolean;
  error?: string;
}

interface UpsertOutcome {
  candidate: {
    id: string;
    name: string | null;
    email: string | null;
    phoneE164: string | null;
    parseFailed: boolean;
    cvParsed: unknown;
  };
  created: boolean;
}

function extractionOf(cvParsed: unknown): { reason?: string | null; needsOcr?: boolean } {
  if (!cvParsed || typeof cvParsed !== "object") return {};
  const extraction = (cvParsed as Record<string, unknown>).extraction;
  if (!extraction || typeof extraction !== "object") return {};
  const e = extraction as Record<string, unknown>;
  return {
    reason: typeof e.reason === "string" ? e.reason : null,
    needsOcr: e.needsOcr === true,
  };
}

/**
 * Ingest one uploaded CV.
 *
 * Reading and parsing the file happens before `tx` is called, never inside it:
 * a Prisma interactive transaction times out at 5 seconds and a multi-page PDF
 * regularly takes longer than that to decode, which would abort the write and
 * lose the candidate. The same reason the screening route calls the model
 * between two short transactions rather than inside one.
 *
 * Never throws for a bad file — an unreadable CV in a batch of forty must not
 * take the other thirty-nine with it, so the failure is returned as a result
 * row the UI can show against that filename.
 */
export async function ingestCvFile(
  tenantId: string,
  jobId: string,
  file: File,
  actorId: string,
  tx: <T>(cb: (db: TenantTransactionClient) => Promise<T>) => Promise<T>
): Promise<IngestFileResult> {
  const filename = file.name || "unnamed";

  try {
    if (file.size === 0) {
      return { filename, status: "failed", error: "File is empty" };
    }
    if (file.size > MAX_CV_FILE_BYTES) {
      return {
        filename,
        status: "failed",
        error: `File is larger than ${Math.round(MAX_CV_FILE_BYTES / (1024 * 1024))}MB`,
      };
    }

    const cvBuffer = Buffer.from(await file.arrayBuffer());

    const { candidate, created } = (await tx((db) =>
      upsertCandidate(
        tenantId,
        { jobId, cvBuffer, cvFilename: filename, routedBy: "manual", intake: "upload", intakeBy: actorId },
        { client: db }
      )
    )) as UpsertOutcome;

    const { reason, needsOcr } = extractionOf(candidate.cvParsed);

    return {
      filename,
      status: created ? "created" : "merged",
      candidateId: candidate.id,
      name: candidate.name,
      email: candidate.email,
      phoneE164: candidate.phoneE164,
      parseFailed: candidate.parseFailed,
      reason,
      needsOcr,
    };
  } catch (error) {
    return {
      filename,
      status: "failed",
      error: error instanceof Error ? error.message : "Could not read this file",
    };
  }
}

export interface ManualCandidateInput {
  jobId: string;
  name?: string;
  email?: string;
  phone?: string;
  notes?: string;
}

/**
 * Add a candidate typed in by hand. The phone is normalised through the same
 * function the CV parser uses, so a number entered as "98765 43210" dedupes
 * against the identical number read out of a PDF.
 */
export async function ingestManualCandidate(
  tenantId: string,
  input: ManualCandidateInput,
  actorId: string,
  tx: <T>(cb: (db: TenantTransactionClient) => Promise<T>) => Promise<T>
): Promise<IngestFileResult> {
  const phoneE164 = input.phone ? normalizePhoneE164(input.phone) : null;
  if (input.phone && !phoneE164) {
    throw new ValidationError(
      `"${input.phone}" is not a phone number we can call. Use a 10-digit Indian mobile or a number with its country code.`
    );
  }

  const { candidate, created } = (await tx((db) =>
    upsertCandidate(
      tenantId,
      {
        jobId: input.jobId,
        routedBy: "manual",
        intake: "manual",
        intakeBy: actorId,
        // Pasted notes go through the CV text parser so screening sees the
        // same shape of skills, education and experience it gets from a PDF —
        // a candidate added by hand should not score worse for having been.
        // The typed fields then overlay it: a person who filled in the name
        // box means that name, whatever the parser guessed from the prose.
        parsed: {
          ...parseCvText(input.notes ?? ""),
          ...(input.name ? { name: input.name } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(phoneE164 ? { phone: phoneE164 } : {}),
          source: "manual_entry",
        },
      },
      { client: db }
    )
  )) as UpsertOutcome;

  return {
    filename: input.name || input.email || input.phone || "candidate",
    status: created ? "created" : "merged",
    candidateId: candidate.id,
    name: candidate.name,
    email: candidate.email,
    phoneE164: candidate.phoneE164,
    parseFailed: candidate.parseFailed,
  };
}
