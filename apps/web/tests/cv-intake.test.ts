import { describe, it, expect, beforeEach } from "vitest";
import {
  CV_UPLOAD_BATCH_BYTES,
  CV_UPLOAD_BATCH_SIZE,
  MAX_CV_FILE_BYTES,
  MAX_CV_UPLOAD_FILES,
  MAX_CV_UPLOAD_TOTAL_BYTES,
  planCvUploadBatches,
  ValidationError,
} from "@pratibha/shared";
import { ingestCvFile, ingestManualCandidate } from "@/lib/cv-intake";
import type { TenantTransactionClient } from "@/lib/authz";

/**
 * Covers the manual-intake path end to end apart from the database: real files
 * go through the real extractor and the real parser, and only the Prisma client
 * is faked. The dedupe rules are the point of these tests — a CV uploaded by
 * hand has to merge with the same person's row rather than duplicate them, and
 * that only holds if upload and mailbox ingestion share the matching logic.
 */

const TENANT = "tenant_1";
const JOB = "job_1";
const ACTOR = "user_1";

interface Row {
  id: string;
  tenantId: string;
  jobId: string;
  name: string | null;
  email: string | null;
  phoneE164: string | null;
  sourceEmailMsgId: string | null;
  parseFailed: boolean;
  noPhone: boolean;
  cvParsed: Record<string, unknown>;
  [key: string]: unknown;
}

function fakeDb() {
  const rows: Row[] = [];
  let seq = 0;

  const client = {
    candidate: {
      findUnique: async ({ where }: any) =>
        rows.find((r) =>
          where.sourceEmailMsgId !== undefined
            ? r.sourceEmailMsgId === where.sourceEmailMsgId
            : r.id === where.id
        ) ?? null,

      findFirst: async ({ where }: any) => {
        // Prisma treats OR: [] as matching nothing; a CV with neither a phone
        // nor an email must not merge into the first row it finds.
        const or = where.OR ?? [];
        if (or.length === 0) return null;
        return (
          rows.find(
            (r) =>
              r.tenantId === where.tenantId &&
              r.jobId === where.jobId &&
              or.some((clause: any) =>
                clause.phoneE164 !== undefined
                  ? r.phoneE164 === clause.phoneE164
                  : r.email === clause.email
              )
          ) ?? null
        );
      },

      create: async ({ data }: any) => {
        const row = { id: `cand_${++seq}`, ...data } as Row;
        rows.push(row);
        return row;
      },

      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };

  const tx = <T,>(cb: (db: TenantTransactionClient) => Promise<T>) =>
    cb(client as unknown as TenantTransactionClient);

  return { rows, tx };
}

function textCv(name: string, body: string): File {
  return new File([body], name, { type: "text/plain" });
}

const PRIYA = [
  "Priya Sharma",
  "priya.sharma@example.com",
  "+91 98765 43210",
  "",
  "8 years of experience building services in Node.js and TypeScript.",
  "B.Tech, Computer Science.",
].join("\n");

describe("ingestCvFile", () => {
  let db: ReturnType<typeof fakeDb>;

  beforeEach(() => {
    db = fakeDb();
  });

  it("creates a candidate from an uploaded text CV", async () => {
    const result = await ingestCvFile(TENANT, JOB, textCv("priya.txt", PRIYA), ACTOR, db.tx);

    expect(result.status).toBe("created");
    expect(result.parseFailed).toBe(false);
    expect(result.email).toBe("priya.sharma@example.com");
    expect(result.phoneE164).toBe("+919876543210");
    expect(db.rows).toHaveLength(1);
  });

  it("records who added the CV and how, so a hand-added row is identifiable", async () => {
    await ingestCvFile(TENANT, JOB, textCv("priya.txt", PRIYA), ACTOR, db.tx);

    expect(db.rows[0].routedBy).toBe("manual");
    expect(db.rows[0].cvParsed.intake).toMatchObject({ via: "upload", by: ACTOR });
  });

  it("merges a re-uploaded CV into the existing candidate instead of duplicating", async () => {
    await ingestCvFile(TENANT, JOB, textCv("priya.txt", PRIYA), ACTOR, db.tx);
    const again = await ingestCvFile(
      TENANT,
      JOB,
      // Trailing punctuation defeats the parser's skill matcher, so the
      // fixture spaces the terms the way a real CV's skills line does.
      textCv("priya-updated.txt", `${PRIYA}\nAlso Kubernetes and Terraform daily.`),
      ACTOR,
      db.tx
    );

    expect(again.status).toBe("merged");
    expect(db.rows).toHaveLength(1);
    // The newer CV replaces the parsed blob, so screening sees the new skills.
    expect(JSON.stringify(db.rows[0].cvParsed)).toContain("terraform");
  });

  it("keeps two different people apart", async () => {
    await ingestCvFile(TENANT, JOB, textCv("priya.txt", PRIYA), ACTOR, db.tx);
    const other = await ingestCvFile(
      TENANT,
      JOB,
      textCv("arun.txt", "Arun Nair\narun@example.com\n+91 91234 56789\nGo and Kafka."),
      ACTOR,
      db.tx
    );

    expect(other.status).toBe("created");
    expect(db.rows).toHaveLength(2);
  });

  it("reports an empty file as failed without touching the database", async () => {
    const result = await ingestCvFile(TENANT, JOB, textCv("blank.txt", ""), ACTOR, db.tx);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/empty/i);
    expect(db.rows).toHaveLength(0);
  });

  it("refuses a file past the size ceiling before reading it into memory", async () => {
    const huge = new File(["x"], "huge.pdf");
    Object.defineProperty(huge, "size", { value: 20 * 1024 * 1024 });

    const result = await ingestCvFile(TENANT, JOB, huge, ACTOR, db.tx);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/larger than/i);
    expect(db.rows).toHaveLength(0);
  });

  it("stores an unreadable file as an unparsed candidate rather than losing it", async () => {
    // A .docx is a zip container the extractor deliberately does not open.
    const docx = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])], "cv.docx");

    const result = await ingestCvFile(TENANT, JOB, docx, ACTOR, db.tx);

    expect(result.status).toBe("created");
    expect(result.parseFailed).toBe(true);
    expect(result.reason).toMatch(/unsupported/i);
    // It is still in the pipeline, flagged for someone to fill in by hand.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].parseFailed).toBe(true);
  });

  it("does not merge two unparsed files into one candidate", async () => {
    const blob = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])], "cv.docx");

    await ingestCvFile(TENANT, JOB, blob(), ACTOR, db.tx);
    await ingestCvFile(TENANT, JOB, blob(), ACTOR, db.tx);

    // Neither has a phone or an email, so there is nothing to match on. Folding
    // them together would silently merge two unrelated applicants.
    expect(db.rows).toHaveLength(2);
  });
});

describe("ingestManualCandidate", () => {
  let db: ReturnType<typeof fakeDb>;

  beforeEach(() => {
    db = fakeDb();
  });

  it("normalises a hand-typed phone number to E.164", async () => {
    const result = await ingestManualCandidate(
      TENANT,
      { jobId: JOB, name: "Priya Sharma", phone: "98765 43210" },
      ACTOR,
      db.tx
    );

    expect(result.status).toBe("created");
    expect(result.phoneE164).toBe("+919876543210");
    expect(db.rows[0].noPhone).toBe(false);
  });

  it("rejects a phone number that could never be dialled", async () => {
    await expect(
      ingestManualCandidate(TENANT, { jobId: JOB, name: "Priya", phone: "12345" }, ACTOR, db.tx)
    ).rejects.toBeInstanceOf(ValidationError);

    expect(db.rows).toHaveLength(0);
  });

  it("dedupes a typed-in candidate against one added from a CV", async () => {
    await ingestCvFile(TENANT, JOB, textCv("priya.txt", PRIYA), ACTOR, db.tx);

    // Same number, written the way a person would type it off a phone screen.
    const result = await ingestManualCandidate(
      TENANT,
      { jobId: JOB, name: "Priya S", phone: "098765 43210" },
      ACTOR,
      db.tx
    );

    expect(result.status).toBe("merged");
    expect(db.rows).toHaveLength(1);
  });

  it("runs pasted notes through the CV parser so screening has skills to match", async () => {
    await ingestManualCandidate(
      TENANT,
      {
        jobId: JOB,
        name: "Arun Nair",
        email: "arun@example.com",
        notes: "Six years with Python, Django and PostgreSQL on AWS infrastructure.",
      },
      ACTOR,
      db.tx
    );

    const parsed = db.rows[0].cvParsed as { skills: string[]; name: string };
    expect(parsed.skills).toEqual(expect.arrayContaining(["python", "django", "postgresql", "aws"]));
    // The typed name wins over whatever the parser guessed from the prose.
    expect(parsed.name).toBe("Arun Nair");
  });
});

describe("bulk import limits", () => {
  it("imports a hundred CVs at a time", () => {
    expect(MAX_CV_UPLOAD_FILES).toBe(100);
  });

  it("never batches more files than one request may carry", () => {
    // The UI splits a selection with planCvUploadBatches and the route rejects
    // anything over MAX_CV_UPLOAD_FILES. Letting the batch size past the cap
    // would make every import fail with a validation error the recruiter cannot
    // act on, so the relationship is pinned rather than left to review.
    expect(CV_UPLOAD_BATCH_SIZE).toBeLessThanOrEqual(MAX_CV_UPLOAD_FILES);
  });

  it("never batches more bytes than one request may carry", () => {
    expect(CV_UPLOAD_BATCH_BYTES).toBeLessThanOrEqual(MAX_CV_UPLOAD_TOTAL_BYTES);
  });

  it("leaves room for a single largest-permitted file in one batch", () => {
    // Below this, a file the server would accept could never be put in a batch,
    // so it would be unsendable through the UI for no stated reason.
    expect(MAX_CV_FILE_BYTES).toBeLessThanOrEqual(CV_UPLOAD_BATCH_BYTES);
  });
});

describe("planCvUploadBatches", () => {
  const small = (n: number) => Array.from({ length: n }, () => ({ size: 200 * 1024 }));

  it("sends a single CV as one request", () => {
    expect(planCvUploadBatches(small(1))).toHaveLength(1);
  });

  it("splits a hundred ordinary CVs by the count limit", () => {
    const batches = planCvUploadBatches(small(100));

    expect(batches).toHaveLength(Math.ceil(100 / CV_UPLOAD_BATCH_SIZE));
    expect(batches.every((b) => b.length <= CV_UPLOAD_BATCH_SIZE)).toBe(true);
    expect(batches.flat()).toHaveLength(100);
  });

  it("splits on bytes when the files are large, before the count is reached", () => {
    // Five 8MB scans are only five files, but 40MB in one request — twice the
    // byte budget and the shape that breaks in deployment while passing locally.
    const batches = planCvUploadBatches(Array.from({ length: 5 }, () => ({ size: 8 * 1024 * 1024 })));

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      const bytes = batch.reduce((sum, f) => sum + f.size, 0);
      expect(bytes).toBeLessThanOrEqual(CV_UPLOAD_BATCH_BYTES);
    }
  });

  it("still sends a file bigger than the whole batch budget, in a batch of its own", () => {
    // The server rejects it per-file and names it in the results; dropping it
    // here would let a recruiter believe it had been imported.
    const oversized = CV_UPLOAD_BATCH_BYTES + 1;
    const batches = planCvUploadBatches([
      { size: 200 * 1024 },
      { size: oversized },
      { size: 200 * 1024 },
    ]);

    expect(batches.flat()).toHaveLength(3);
    expect(batches.some((b) => b.length === 1 && b[0].size === oversized)).toBe(true);
  });

  it("loses nothing and reorders nothing", () => {
    const files = Array.from({ length: 57 }, (_, i) => ({ size: 300 * 1024, id: i }));
    expect(planCvUploadBatches(files).flat().map((f) => f.id)).toEqual(files.map((f) => f.id));
  });

  it("returns no batches for an empty selection", () => {
    expect(planCvUploadBatches([])).toEqual([]);
  });
});
