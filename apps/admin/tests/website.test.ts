import { describe, expect, it } from "vitest";
import type { SiteEntry } from "@pratibha/prisma";
import { PAGE_KEYS, validateEntry } from "@/lib/website/schema";
import { assembleContent } from "@/lib/website/store";

const page = { title: "A title", description: "A description", inSitemap: true };
const company = {
  brandName: "Pratibha",
  legalName: "ProMonkey Technologies LLP",
  llpin: "",
  registeredOffice: "IN-102, 9/2-F, East Patel Nagar, New Delhi 110008",
  operatingOffice: "",
  email: "info@pratibha.tech",
  phone: "",
  grievanceOfficer: { name: "", designation: "", email: "" },
  jurisdiction: "Gurugram, Haryana",
};
const post = { id: "p1", slug: "hello-world", title: "Hello", excerpt: "Short", category: "Guides", readTime: "2 min read", body: "", status: "draft" };

let n = 0;
function row(kind: string, key: string, draft: unknown, live: unknown = draft, position = 0): SiteEntry {
  return { id: `r${n++}`, kind, key, position, draft, live, updatedBy: null, updatedAt: new Date(), publishedAt: null } as SiteEntry;
}
const base = () => [...PAGE_KEYS.map((k) => row("page", k, page)), row("company", "company", company)];

describe("website validation", () => {
  it("accepts a page and refuses an unknown page key", () => {
    expect(validateEntry("page", "home", page).ok).toBe(true);
    expect(validateEntry("page", "nope", page).ok).toBe(false);
  });

  it("refuses a runaway title over 120 characters", () => {
    const r = validateEntry("page", "home", { ...page, title: "x".repeat(121) });
    expect(r.ok).toBe(false);
  });

  it("refuses a share image that is not https or a path", () => {
    expect(validateEntry("page", "home", { ...page, ogImage: "http://x.com/a.png" }).ok).toBe(false);
    expect(validateEntry("page", "home", { ...page, ogImage: "/images/a.png" }).ok).toBe(true);
  });

  it("allows an empty LLPIN and grievance officer", () => {
    expect(validateEntry("company", "company", company).ok).toBe(true);
  });

  it("refuses a bad slug and a published post without a body", () => {
    expect(validateEntry("post", "p1", { ...post, slug: "Hello World" }).ok).toBe(false);
    const r = validateEntry("post", "p1", { ...post, status: "published" });
    expect(r.ok).toBe(false);
    expect(validateEntry("post", "p1", { ...post, status: "published", body: "word ".repeat(20) }).ok).toBe(true);
  });

  it("needs a group on FAQ items", () => {
    expect(validateEntry("faq", "f1", { id: "f1", question: "Q?", answer: "A." }).ok).toBe(false);
    expect(validateEntry("faq", "f1", { id: "f1", question: "Q?", answer: "A.", group: "home" }).ok).toBe(true);
  });
});

describe("assembleContent", () => {
  it("builds the draft site, leaving out removed items and ordering by position", () => {
    const rows = [
      ...base(),
      row("testimonial", "t2", { id: "t2", quote: "Two", name: "B", role: "R" }, null, 1),
      row("testimonial", "t1", { id: "t1", quote: "One", name: "A", role: "R" }, null, 0),
      row("testimonial", "gone", null, { id: "gone", quote: "x", name: "x", role: "x" }, 2),
      row("faq", "f1", { id: "f1", question: "Q", answer: "A", group: "pricing" }),
      row("post", "p1", post),
    ];
    const draft = assembleContent(rows, "draft");
    expect(draft.testimonials.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(draft.faq.pricing).toEqual([{ id: "f1", question: "Q", answer: "A" }]);
    expect(draft.faq.home).toEqual([]);
    expect(draft.posts).toHaveLength(1);

    const live = assembleContent(rows, "live");
    expect(live.testimonials.map((t) => t.id)).toEqual(["gone"]);
  });

  it("refuses to build without every page", () => {
    const rows = base().filter((r) => r.key !== "dpa");
    expect(() => assembleContent(rows, "draft")).toThrow(/Data Processing Agreement/);
  });
});
