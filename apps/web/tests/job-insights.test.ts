import { describe, it, expect } from "vitest";
import { attentionFor, publishStateOf, type JobCounts } from "@/lib/job-insights";

const counts = (over: Partial<JobCounts> = {}): JobCounts => ({
  applications: 0,
  screened: 0,
  shortlisted: 0,
  awaitingApproval: 0,
  interviewed: 0,
  recommended: 0,
  missingPhone: 0,
  ...over,
});

const at = (iso: string) => new Date(iso);
const post = (postedAt: string) => ({ status: "posted", postedAt: at(postedAt), createdAt: at("2026-09-16T05:00:00Z") });
const jd = (createdAt: string, approved = true) => ({
  id: "jd-2",
  version: 2,
  approvedAt: approved ? at(createdAt) : null,
  createdAt: at(createdAt),
});

// J11 — Live, Live · edited and Draft come from timestamps.
describe("publish state", () => {
  it("is Draft when never published", () => {
    expect(publishStateOf({ status: "draft", deletedAt: null, careersPost: null, latestJd: jd("2026-09-20T00:00:00Z") }).state).toBe("draft");
  });

  it("is Live when no JD version was saved after the last publish", () => {
    const p = publishStateOf({
      status: "open",
      deletedAt: null,
      careersPost: post("2026-09-26T10:00:00Z"),
      latestJd: jd("2026-09-25T10:00:00Z"),
    });
    expect(p.state).toBe("live");
    expect(p.jdChangedAt).toBeNull();
    expect(p.firstPublishedAt).toBe("2026-09-16T05:00:00.000Z");
  });

  it("flips to Live · edited when a version is saved after publishing, and back on republish", () => {
    const edited = publishStateOf({
      status: "open",
      deletedAt: null,
      careersPost: post("2026-09-26T10:00:00Z"),
      latestJd: jd("2026-09-27T09:00:00Z", false),
    });
    expect(edited.state).toBe("live_edited");
    expect(edited.jdChangedAt).toBe("2026-09-27T09:00:00.000Z");

    const republished = publishStateOf({
      status: "open",
      deletedAt: null,
      careersPost: post("2026-09-27T12:00:00Z"),
      latestJd: jd("2026-09-27T09:00:00Z"),
    });
    expect(republished.state).toBe("live");
  });

  it("is not live when the role is not open, whatever the post row says", () => {
    expect(publishStateOf({ status: "closed", deletedAt: null, careersPost: post("2026-09-26T10:00:00Z"), latestJd: null }).state).toBe("draft");
  });

  it("is Archived once archived", () => {
    expect(
      publishStateOf({ status: "closed", deletedAt: at("2026-09-28T00:00:00Z"), careersPost: null, latestJd: null }).state
    ).toBe("archived");
  });
});

// J12 — one strip, most urgent first.
describe("attention strip priority", () => {
  const live = publishStateOf({ status: "open", deletedAt: null, careersPost: post("2026-09-26T10:00:00Z"), latestJd: null });
  const edited = publishStateOf({
    status: "open",
    deletedAt: null,
    careersPost: post("2026-09-26T10:00:00Z"),
    latestJd: jd("2026-09-27T09:00:00Z"),
  });
  const draft = publishStateOf({ status: "draft", deletedAt: null, careersPost: null, latestJd: null });

  it("puts a shortlist waiting for approval above everything", () => {
    const a = attentionFor(counts({ awaitingApproval: 3, missingPhone: 2 }), edited);
    expect(a).toMatchObject({ kind: "approval", count: 3, tab: "shortlist", action: "Review" });
  });

  it("then a stale public page", () => {
    expect(attentionFor(counts({ missingPhone: 2 }), edited)).toMatchObject({ kind: "republish", tab: "publish" });
  });

  it("then CVs without a phone number", () => {
    expect(attentionFor(counts({ missingPhone: 2 }), draft)).toMatchObject({
      kind: "missing_phone",
      count: 2,
      tab: "candidates?missing=phone",
    });
  });

  it("then a role that is not published", () => {
    expect(attentionFor(counts(), draft)).toMatchObject({ kind: "not_published", tab: "publish" });
  });

  it("shows nothing when nothing needs a person", () => {
    expect(attentionFor(counts({ applications: 12, screened: 12 }), live)).toBeNull();
  });
});
