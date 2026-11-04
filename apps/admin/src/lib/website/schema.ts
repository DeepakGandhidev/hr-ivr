import { z } from "zod";

/**
 * The marketing site's editable content, as the admin panel validates it.
 *
 * Mirrors src/content/schema.ts in the website repo (sparsh160/pratibha). The
 * site is built from a JSON file in exactly this shape, so keep the two in
 * step: a field added here and not there is silently ignored by the site.
 */

export const PAGE_KEYS = [
  "home",
  "about",
  "features",
  "pricing",
  "blog",
  "contact",
  "terms",
  "privacy",
  "refund",
  "shipping",
  "dpa",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export const PAGE_LABELS: Record<PageKey, { label: string; path: string }> = {
  home: { label: "Home", path: "/" },
  about: { label: "About", path: "/about" },
  features: { label: "Features", path: "/features" },
  pricing: { label: "Pricing", path: "/pricing" },
  blog: { label: "Blog", path: "/blog" },
  contact: { label: "Contact", path: "/contact" },
  terms: { label: "Terms of Service", path: "/terms" },
  privacy: { label: "Privacy Policy", path: "/privacy" },
  refund: { label: "Refund Policy", path: "/refund" },
  shipping: { label: "Shipping Policy", path: "/shipping" },
  dpa: { label: "Data Processing Agreement", path: "/dpa" },
};

const text = (label: string, max: number, min = 1) =>
  z
    .string()
    .trim()
    .min(min, min > 0 ? `${label} cannot be empty.` : undefined)
    .max(max, `Keep ${label.toLowerCase()} under ${max} characters.`);

const optionalUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || v.startsWith("/") || /^https:\/\/\S+$/.test(v), "Use a full https:// address or a path starting with /.")
  .optional()
  .transform((v) => (v ? v : undefined));

// Search engines cut titles near 60 characters and descriptions near 160; the
// form warns past those. These caps only stop runaway text.
export const pageSchema = z.object({
  title: text("Title", 120),
  description: text("Description", 320),
  ogImage: optionalUrl,
  inSitemap: z.boolean(),
});

export const companySchema = z.object({
  brandName: text("Brand name", 60),
  legalName: text("Legal name", 120),
  llpin: z.string().trim().max(20),
  registeredOffice: text("Registered office", 300),
  operatingOffice: z.string().trim().max(300),
  email: z.string().trim().email("Enter a valid email address."),
  phone: z.string().trim().max(30),
  grievanceOfficer: z.object({
    name: z.string().trim().max(120),
    designation: z.string().trim().max(120),
    email: z.union([z.literal(""), z.string().trim().email("Enter a valid grievance officer email.")]),
  }),
  jurisdiction: text("Jurisdiction", 120),
});

export const testimonialSchema = z.object({
  id: z.string().min(1).max(60),
  quote: text("Quote", 600),
  name: text("Name", 80),
  role: text("Role", 120),
  photo: optionalUrl,
});

export const faqGroupSchema = z.enum(["home", "pricing"]);
export type FaqGroup = z.infer<typeof faqGroupSchema>;

export const faqSchema = z.object({
  id: z.string().min(1).max(60),
  question: text("Question", 200),
  answer: text("Answer", 2000),
});

export const POST_STATUSES = ["draft", "coming_soon", "published"] as const;

export const postSchema = z
  .object({
    id: z.string().min(1).max(60),
    slug: z
      .string()
      .trim()
      .min(3, "The URL needs at least 3 characters.")
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "The URL can only use lowercase letters, digits and single hyphens."),
    title: text("Title", 140),
    excerpt: text("Excerpt", 300),
    category: text("Category", 40),
    readTime: z.string().trim().max(30),
    image: optionalUrl,
    body: z.string().max(100_000, "Keep the article under 100,000 characters."),
    status: z.enum(POST_STATUSES),
    publishedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional(),
    author: z.string().trim().max(80).optional().transform((v) => (v ? v : undefined)),
    seoTitle: z.string().trim().max(120).optional().transform((v) => (v ? v : undefined)),
    seoDescription: z.string().trim().max(320).optional().transform((v) => (v ? v : undefined)),
  })
  .refine((p) => p.status !== "published" || p.body.trim().length >= 50, {
    message: "A published post needs an article body (at least 50 characters).",
    path: ["body"],
  });

export type PageSeo = z.infer<typeof pageSchema>;
export type Company = z.infer<typeof companySchema>;
export type Testimonial = z.infer<typeof testimonialSchema>;
export type FaqItem = z.infer<typeof faqSchema> & { group: FaqGroup };
export type Post = z.infer<typeof postSchema>;

/** The file the site is built from (src/content/schema.ts: SiteContent). */
export interface SiteContent {
  version: 1;
  pages: Record<PageKey, PageSeo>;
  company: Company;
  testimonials: Testimonial[];
  faq: { home: Omit<FaqItem, "group">[]; pricing: Omit<FaqItem, "group">[] };
  posts: Post[];
}

export type EntryKind = "page" | "company" | "testimonial" | "faq" | "post";

/** Validate one item's data for its kind; returns the cleaned value or a sentence. */
export function validateEntry(kind: EntryKind, key: string, data: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  let schema: z.ZodTypeAny;
  switch (kind) {
    case "page":
      if (!(PAGE_KEYS as readonly string[]).includes(key)) return { ok: false, error: `Unknown page ${key}.` };
      schema = pageSchema;
      break;
    case "company":
      schema = companySchema;
      break;
    case "testimonial":
      schema = testimonialSchema;
      break;
    case "faq":
      schema = faqSchema.extend({ group: faqGroupSchema });
      break;
    case "post":
      schema = postSchema;
      break;
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
  return { ok: true, value: parsed.data };
}
