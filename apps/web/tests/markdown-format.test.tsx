import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { firstLine, firstSentence, markdownToPlain, sentencesOf, truncateEnd } from "@/components/Markdown";
import { describeCallWindows, formatDate, formatDateTime, plural, timeAgo } from "@/lib/format";

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} />);

/** Text a reader would see, with tags removed. */
const visible = (src: string) => html(src).replace(/<[^>]+>/g, " ");

describe("J01 markdown renders instead of showing syntax", () => {
  const jd = [
    "## About the role",
    "We are looking for a **results driven** Senior Sales Expert in _Gurugram_.",
    "",
    "---",
    "",
    "### What you will do",
    "- Lead end to end sales",
    "- Win clients on **Upwork**",
    "  - nested detail",
    "",
    "1. First",
    "2. Second",
    "",
    "***",
    "***Bold italic*** and *italic* and __bold__",
  ].join("\n");

  it("renders headings, emphasis, lists and dividers", () => {
    const out = html(jd);
    expect(out).toContain("<h3>About the role</h3>");
    expect(out).toContain("<h4>What you will do</h4>");
    expect(out).toContain("<strong>results driven</strong>");
    expect(out).toContain("<em>Gurugram</em>");
    expect(out).toContain("<ul><li>Lead end to end sales</li>");
    expect(out).toContain("<ol><li>First</li><li>Second</li></ol>");
    expect(out).toContain("<hr/>");
    expect(out).toContain("<strong><em>Bold italic</em></strong>");
  });

  it("leaves no literal markdown syntax visible", () => {
    const text = visible(jd);
    expect(text).not.toMatch(/#|\*\*|__|^\s*-\s/m);
    expect(text).not.toContain("---");
    expect(text).not.toContain("***");
  });

  it("drops unpaired markers from malformed model output", () => {
    expect(visible("**Strengths: good closer")).not.toContain("**");
  });

  it("keeps snake_case and never renders raw HTML", () => {
    expect(visible("use job_id here")).toContain("job_id");
    const out = html("<script>alert(1)</script> [x](javascript:alert(1))");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain('href="javascript');
  });

  it("renders a pipe table with header cells", () => {
    const out = html("| Skill | Level |\n|---|---|\n| Sales | High |");
    expect(out).toContain('<th scope="col">Skill</th>');
    expect(out).toContain("<td>High</td>");
  });

  it("gives plain text for previews", () => {
    expect(markdownToPlain("## Title\n- **one**\n---\n_two_")).toBe("Title\none\ntwo");
    expect(firstLine("\n\n**Meets all four** must haves.\nSecond line")).toBe("Meets all four must haves.");
    expect(firstSentence("Strong seller. Expects more than the cap.")).toBe("Strong seller.");
    expect(sentencesOf("One. Two! Three")).toEqual(["One.", "Two!", "Three"]);
  });
});

describe("J04 previews truncate from the end", () => {
  it("starts at the first word and ends with an ellipsis", () => {
    const text = "You have sold AI voice agents and document extraction. Tell me about one deal.";
    const cut = truncateEnd(text, 40);
    expect(cut.startsWith("You have sold")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(41);
  });

  it("leaves short text alone", () => {
    expect(truncateEnd("  Short answer.  ", 40)).toBe("Short answer.");
  });
});

describe("J05 pluralization and timestamps", () => {
  it("pluralizes without (s)", () => {
    expect(plural(1, "candidate")).toBe("1 candidate");
    expect(plural(3, "candidate")).toBe("3 candidates");
    expect(plural(0, "interview")).toBe("0 interviews");
  });

  it("formats times with no seconds and a short month", () => {
    const at = "2026-09-25T11:37:45Z";
    expect(formatDateTime(at, "Asia/Kolkata")).toBe("25 Sep 2026, 5:07 pm");
    expect(formatDateTime("2026-09-24T20:11:00Z", "Asia/Kolkata")).toBe("25 Sep 2026, 1:41 am");
    expect(formatDate(at, "Asia/Kolkata")).toBe("25 Sep 2026");
    expect(formatDateTime(at, "Asia/Kolkata")).not.toMatch(/:\d{2}:\d{2}/);
  });

  it("says how long ago in words", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(timeAgo("2026-09-29T10:00:00Z", now)).toBe("2 hours ago");
    expect(timeAgo("2026-09-29T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-09-28T12:00:00Z", now)).toBe("1 day ago");
  });

  it("describes call windows in words", () => {
    expect(describeCallWindows([{ days: [1, 2, 3, 4, 5, 6], startTime: "10:00", endTime: "18:00" }])).toBe(
      "Mon to Sat, 10 am to 6 pm"
    );
    expect(describeCallWindows([])).toBe("any time the line is open");
  });
});
