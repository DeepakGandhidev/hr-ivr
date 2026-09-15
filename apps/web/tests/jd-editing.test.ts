import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const jobRoute = readFileSync(
  path.join(APP_ROOT, "src/app/api/[tenant]/jobs/[id]/route.ts"),
  "utf8"
);
const editPage = readFileSync(
  path.join(APP_ROOT, "src/app/[tenant]/jobs/[id]/edit/page.tsx"),
  "utf8"
);

/**
 * The JD body is edited in the same form as the structured fields, and both
 * have to land or neither: a description saved while the structured write
 * failed leaves the advert describing a role that no longer matches its own
 * requirements.
 */
describe("JD editing", () => {
  it("accepts the body on the job update endpoint", () => {
    expect(jobRoute).toContain("bodyMd: z.string()");
  });

  it("creates the description version inside the job's transaction", () => {
    const txStart = jobRoute.indexOf("withTenantAuth(tenant, Action.jobUpdate");
    const jdCreate = jobRoute.indexOf("tx.jobDescription.create");
    const jobUpdate = jobRoute.indexOf("tx.job.update");

    expect(txStart).toBeGreaterThan(-1);
    expect(jdCreate).toBeGreaterThan(txStart);
    // Before the job row is written, alongside the structured snapshot.
    expect(jdCreate).toBeLessThan(jobUpdate);
  });

  // Every save posts the body, so without this each salary-band tweak would
  // create an identical JD version and bury the real edits.
  it("only versions the body when it actually changed", () => {
    expect(jobRoute).toContain('next !== (currentJd?.bodyMd ?? "").trim()');
  });

  it("writes an audit entry naming both versions", () => {
    expect(jobRoute).toContain('action: "job.description.edited"');
  });

  it("still reports that a live posting needs republishing", () => {
    expect(jobRoute).toContain("requiresRepublish: existing.posts.length > 0");
    expect(editPage).toContain("The job description has changed");
  });

  /**
   * The job payload filters descriptions to approved ones, because the publish
   * screen must tell "none written" from "written but not approved". Editing
   * from that list would silently discard an unapproved draft.
   */
  it("loads every version for editing, not just approved ones", () => {
    expect(editPage).toContain("/descriptions`");
  });
});

/**
 * The preview renders user-authored text on a page admins use. It must never
 * reach for innerHTML.
 */
describe("markdown preview safety", () => {
  const raw = readFileSync(path.join(APP_ROOT, "src/components/MarkdownEditor.tsx"), "utf8");
  // Comments stripped: the file explains at length why it avoids innerHTML,
  // and matching that prose would fail the test for saying the right thing.
  const editor = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("never uses dangerouslySetInnerHTML", () => {
    expect(editor).not.toContain("dangerouslySetInnerHTML");
  });

  it("only allows http(s) links", () => {
    expect(raw).toContain("/^https?:\\/\\//i.test(m[7])");
  });
});
