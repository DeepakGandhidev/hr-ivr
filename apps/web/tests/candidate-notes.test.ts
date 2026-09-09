import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(APP_ROOT, p), "utf8");

const noteRoute = read("src/app/api/[tenant]/candidates/[id]/notes/[noteId]/route.ts");
const notesRoute = read("src/app/api/[tenant]/candidates/[id]/notes/route.ts");
const migration = read(
  "../../packages/prisma/migrations/20260909083849_job_versions_soft_delete_candidate_notes/migration.sql"
);

/**
 * A note is one person's written judgement of a named candidate, and a hiring
 * decision may later have to be defended on it. If a colleague can quietly
 * rewrite or remove someone else's words, the record of who thought what stops
 * being trustworthy — so authorship is enforced on the server, in both verbs.
 */
describe("notes can only be changed by their author", () => {
  it("checks authorship before updating", () => {
    expect(noteRoute).toMatch(/note\.authorId !== ctx\.user\.id/);
    expect(noteRoute).toMatch(/Only the author can edit this note/);
  });

  it("checks authorship before deleting", () => {
    // Both verbs, separately: guarding only PATCH would leave delete open.
    const deleteBlock = noteRoute.slice(noteRoute.indexOf("export async function DELETE"));
    expect(deleteBlock).toMatch(/note\.authorId !== ctx\.user\.id/);
    expect(deleteBlock).toMatch(/Only the author can delete this note/);
  });

  it("does not exempt any role from the authorship rule", () => {
    // No role check may stand in for authorship here. An owner is still not
    // the author, and must not be able to edit someone else's words.
    expect(noteRoute).not.toMatch(/UserRole\.(owner|admin)/);
  });

  it("confirms the note belongs to the candidate in the URL", () => {
    // Without this, a note id from another candidate could be edited through
    // any candidate's endpoint that the caller can read.
    expect(noteRoute).toMatch(/note\.candidateId !== id/);
  });
});

describe("anyone who can read a candidate can add a note", () => {
  it("gates creation on candidateRead, not a write action", () => {
    // The people who interview are not always the people with write roles;
    // gating notes behind candidateUpdate would stop them recording anything.
    expect(notesRoute).toMatch(/Action\.candidateRead/);
    expect(notesRoute).not.toMatch(/Action\.candidateUpdate/);
  });
});

/**
 * RLS is per-table in Postgres, so a table created after the enable_rls
 * migration inherits nothing from it. candidate_notes holds a colleague's
 * written opinion of a named person; without its own policy it is readable by
 * every other tenant.
 */
describe("the new tables are covered by row-level security", () => {
  it("enables and forces RLS on candidate_notes and job_versions", () => {
    for (const table of ["candidate_notes", "job_versions"]) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
      expect(migration).toMatch(new RegExp(`CREATE POLICY tenant_isolation ON ${table}`));
    }
  });

  it("scopes each policy through its owning row's tenant", () => {
    expect(migration).toMatch(/candidate_notes[\s\S]*?c\.tenant_id = current_tenant_id\(\)/);
    expect(migration).toMatch(/job_versions[\s\S]*?j\.tenant_id = current_tenant_id\(\)/);
  });

  it("backfills every existing job as version 1", () => {
    // Otherwise history starts empty and the first edit silently discards what
    // the role looked like when its candidates were screened against it.
    expect(migration).toMatch(/INSERT INTO job_versions/);
    expect(migration).toMatch(/FROM jobs j/);
  });
});
