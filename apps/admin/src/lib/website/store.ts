import { randomUUID } from "node:crypto";
import { Prisma, type AdminUser, type SiteEntry } from "@pratibha/prisma";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import { badRequest, conflict, notFound } from "@/lib/http";
import { startBuild, BUILD_TIMEOUT_MS } from "@/lib/website/build";
import {
  PAGE_KEYS,
  PAGE_LABELS,
  validateEntry,
  type Company,
  type EntryKind,
  type FaqGroup,
  type FaqItem,
  type PageKey,
  type PageSeo,
  type Post,
  type SiteContent,
  type Testimonial,
} from "@/lib/website/schema";

/**
 * Website content: drafts, and the publish that makes them live.
 *
 * Every edit writes the row's `draft`; nothing reaches pratibha.tech until
 * someone presses Publish. Publishing copies draft to live for every row in
 * one transaction (under an advisory lock, so two publishes queue), records
 * the full content it produced in site_publishes, and then rebuilds the static
 * site from that content on this server. A failed build leaves the previous
 * site up; Retry rebuilds from the latest published content.
 */

export interface EntryView<T> {
  kind: EntryKind;
  key: string;
  position: number;
  data: T | null;
  /** Never published. */
  isNew: boolean;
  /** Will be removed from the site on the next publish. */
  removed: boolean;
  /** Draft differs from what the site shows. */
  changed: boolean;
  updatedAt: string;
}

export interface PublishView {
  id: string;
  status: "building" | "live" | "failed";
  changes: number;
  startedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  log: string | null;
}

export interface WebsiteOverview {
  pages: EntryView<PageSeo>[];
  company: EntryView<Company> | null;
  testimonials: EntryView<Testimonial>[];
  faq: EntryView<FaqItem>[];
  posts: EntryView<Post>[];
  pending: number;
  publishes: PublishView[];
  publishConfigured: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function view<T>(row: SiteEntry): EntryView<T> {
  return {
    kind: row.kind as EntryKind,
    key: row.key,
    position: row.position,
    data: (row.draft ?? row.live) as T | null,
    isNew: row.live === null,
    removed: row.draft === null,
    changed: !same(row.draft, row.live),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A build left "building" past the timeout died with its process: count it as failed. */
async function expireStaleBuilds() {
  await db.sitePublish.updateMany({
    where: { status: "building", startedAt: { lt: new Date(Date.now() - BUILD_TIMEOUT_MS) } },
    data: { status: "failed", finishedAt: new Date(), log: "The build stopped reporting (the admin panel restarted or the build hung). Press Retry." },
  });
}

export async function websiteOverview(): Promise<WebsiteOverview> {
  await expireStaleBuilds();
  const [rows, publishes, admins] = await Promise.all([
    db.siteEntry.findMany({ orderBy: [{ kind: "asc" }, { position: "asc" }, { updatedAt: "asc" }] }),
    db.sitePublish.findMany({
      orderBy: { startedAt: "desc" },
      take: 8,
      select: { id: true, status: true, changes: true, startedBy: true, startedAt: true, finishedAt: true, log: true },
    }),
    db.adminUser.findMany({ select: { id: true, name: true } }),
  ]);
  const nameOf = new Map(admins.map((a) => [a.id, a.name]));
  const of = (kind: EntryKind) => rows.filter((r) => r.kind === kind);

  const pageOrder = new Map(PAGE_KEYS.map((k, i) => [k as string, i]));
  const posts = of("post")
    .map((r) => view<Post>(r))
    .sort((a, b) => (b.data?.updatedAt ?? "").localeCompare(a.data?.updatedAt ?? ""));

  return {
    pages: of("page")
      .map((r) => view<PageSeo>(r))
      .sort((a, b) => (pageOrder.get(a.key) ?? 99) - (pageOrder.get(b.key) ?? 99)),
    company: of("company")[0] ? view<Company>(of("company")[0]!) : null,
    testimonials: of("testimonial").map((r) => view<Testimonial>(r)),
    faq: of("faq").map((r) => view<FaqItem>(r)),
    posts,
    pending: rows.filter((r) => !same(r.draft, r.live)).length,
    publishes: publishes.map((p) => ({
      id: p.id,
      status: p.status as PublishView["status"],
      changes: p.changes,
      startedBy: p.startedBy ? (nameOf.get(p.startedBy) ?? "Someone") : null,
      startedAt: p.startedAt.toISOString(),
      finishedAt: p.finishedAt?.toISOString() ?? null,
      log: p.log,
    })),
    publishConfigured: Boolean(process.env.SITE_PUBLISH_SCRIPT),
  };
}

function label(kind: EntryKind, key: string, data: any): string {
  switch (kind) {
    case "page":
      return `the ${PAGE_LABELS[key as PageKey]?.label ?? key} page's SEO`;
    case "company":
      return "company details";
    case "testimonial":
      return `the testimonial from ${data?.name ?? "someone"}`;
    case "faq":
      return `the FAQ "${String(data?.question ?? "").slice(0, 60)}"`;
    case "post":
      return `the blog post "${String(data?.title ?? "").slice(0, 60)}"`;
  }
}

const LISTS: EntryKind[] = ["testimonial", "faq", "post"];

export interface SaveEntryInput {
  kind: EntryKind;
  /** Omit to add a new testimonial, FAQ item or post. */
  key?: string;
  data: Record<string, unknown>;
}

export async function saveEntry(admin: AdminUser, input: SaveEntryInput) {
  const { kind } = input;
  const isAdd = !input.key;
  if (isAdd && !LISTS.includes(kind)) throw badRequest("Only testimonials, FAQ items and posts can be added.");
  const key = input.key ?? randomUUID().slice(0, 12);
  if (kind === "company" && key !== "company") throw badRequest("Company details have one entry.");

  const existing = isAdd ? null : await db.siteEntry.findUnique({ where: { kind_key: { kind, key } } });
  if (!isAdd && !existing && kind !== "page" && kind !== "company") throw notFound("That item no longer exists. Reload the page.");

  let data: Record<string, unknown> = { ...input.data };
  if (LISTS.includes(kind)) data.id = key;
  if (kind === "post") {
    const prev = (existing?.draft ?? existing?.live ?? {}) as Partial<Post>;
    data.updatedAt = new Date().toISOString();
    // Published date is set by Publish and kept from then on.
    data.publishedAt = prev.publishedAt;
    if (data.publishedAt === undefined) delete data.publishedAt;
  }

  const checked = validateEntry(kind, key, data);
  if (!checked.ok) throw badRequest(checked.error);
  const value = checked.value as Record<string, unknown>;

  if (kind === "post") {
    const clash = await db.siteEntry.findMany({ where: { kind: "post", NOT: { key } } });
    if (clash.some((r) => ((r.draft ?? r.live) as Post | null)?.slug === value.slug)) {
      throw conflict(`Another post already uses /blog/${value.slug}. Pick a different URL.`);
    }
  }
  if (existing && same(existing.draft, value)) return { message: "Nothing changed.", key };

  await db.$transaction(async (tx) => {
    let position = existing?.position ?? 0;
    if (!existing && LISTS.includes(kind)) {
      const last = await tx.siteEntry.findFirst({ where: { kind }, orderBy: { position: "desc" } });
      position = (last?.position ?? -1) + 1;
    }
    await tx.siteEntry.upsert({
      where: { kind_key: { kind, key } },
      update: { draft: value as Prisma.InputJsonValue, updatedBy: admin.id },
      create: { kind, key, position, draft: value as Prisma.InputJsonValue, updatedBy: admin.id },
    });
    await recordActivity(
      {
        actor: admin,
        action: isAdd ? "website.added" : "website.edited",
        summary: `${admin.name} ${isAdd ? "added" : "edited"} ${label(kind, key, value)} (draft)`,
        before: existing ? { kind, key, value: (existing.draft ?? null) as Prisma.InputJsonValue } : null,
        after: { kind, key, value: value as Prisma.InputJsonValue },
      },
      tx
    );
  });
  return { message: "Saved as a draft. Publish to put it on the website.", key };
}

/** Remove a list item: gone at once if never published, otherwise on the next publish. */
export async function removeEntry(admin: AdminUser, kind: EntryKind, key: string) {
  if (!LISTS.includes(kind)) throw badRequest("Pages and company details cannot be removed.");
  const row = await db.siteEntry.findUnique({ where: { kind_key: { kind, key } } });
  if (!row) throw notFound("That item no longer exists. Reload the page.");
  await db.$transaction(async (tx) => {
    if (row.live === null) await tx.siteEntry.delete({ where: { id: row.id } });
    else await tx.siteEntry.update({ where: { id: row.id }, data: { draft: Prisma.DbNull, updatedBy: admin.id } });
    await recordActivity(
      {
        actor: admin,
        action: "website.removed",
        summary: `${admin.name} removed ${label(kind, key, row.draft ?? row.live)}${row.live === null ? "" : " (on next publish)"}`,
        before: { kind, key, value: (row.draft ?? row.live) as Prisma.InputJsonValue },
      },
      tx
    );
  });
  return { message: row.live === null ? "Removed." : "Removed from the draft. Publish to take it off the website." };
}

/** Throw away unpublished edits (or a pending removal): the draft goes back to what is live. */
export async function discardEntry(admin: AdminUser, kind: EntryKind, key: string) {
  const row = await db.siteEntry.findUnique({ where: { kind_key: { kind, key } } });
  if (!row) throw notFound("That item no longer exists. Reload the page.");
  if (same(row.draft, row.live)) return { message: "Nothing to discard." };
  await db.$transaction(async (tx) => {
    if (row.live === null) await tx.siteEntry.delete({ where: { id: row.id } });
    else await tx.siteEntry.update({ where: { id: row.id }, data: { draft: row.live as Prisma.InputJsonValue, updatedBy: admin.id } });
    await recordActivity(
      { actor: admin, action: "website.discarded", summary: `${admin.name} discarded draft changes to ${label(kind, key, row.live ?? row.draft)}` },
      tx
    );
  });
  return { message: "Draft discarded." };
}

/** Move a testimonial or FAQ item one place up or down (within its FAQ group). */
export async function moveEntry(admin: AdminUser, kind: EntryKind, key: string, direction: "up" | "down") {
  if (kind !== "testimonial" && kind !== "faq") throw badRequest("Only testimonials and FAQ items have an order.");
  const rows = await db.siteEntry.findMany({ where: { kind }, orderBy: [{ position: "asc" }, { updatedAt: "asc" }] });
  const groupOf = (r: SiteEntry) => ((r.draft ?? r.live) as { group?: FaqGroup } | null)?.group ?? null;
  const me = rows.find((r) => r.key === key);
  if (!me) throw notFound("That item no longer exists. Reload the page.");
  const list = rows.filter((r) => groupOf(r) === groupOf(me));
  const i = list.indexOf(me);
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return { message: "Already at the end." };
  [list[i], list[j]] = [list[j]!, list[i]!];

  await db.$transaction(async (tx) => {
    for (const [pos, r] of list.entries()) {
      await tx.siteEntry.update({ where: { id: r.id }, data: { position: pos } });
    }
    await recordActivity({ actor: admin, action: "website.reordered", summary: `${admin.name} moved ${label(kind, key, me.draft ?? me.live)} ${direction}` }, tx);
  });
  return { message: "Moved. Publish to change the order on the website." };
}

/** Build the site's content file from rows, using each row's draft or live copy. */
export function assembleContent(rows: SiteEntry[], which: "draft" | "live"): SiteContent {
  const val = (r: SiteEntry) => r[which] as any;
  const present = rows.filter((r) => val(r) !== null).sort((a, b) => a.position - b.position);
  const pages = {} as Record<PageKey, PageSeo>;
  for (const k of PAGE_KEYS) {
    const row = present.find((r) => r.kind === "page" && r.key === k);
    if (!row) throw badRequest(`The ${PAGE_LABELS[k].label} page has no SEO entry. Run the website import on the server first.`);
    pages[k] = val(row);
  }
  const companyRow = present.find((r) => r.kind === "company");
  if (!companyRow) throw badRequest("Company details are missing. Run the website import on the server first.");

  const faq = present.filter((r) => r.kind === "faq").map((r) => val(r) as FaqItem);
  const strip = ({ group: _g, ...rest }: FaqItem) => rest;
  return {
    version: 1,
    pages,
    company: val(companyRow),
    testimonials: present.filter((r) => r.kind === "testimonial").map(val),
    faq: { home: faq.filter((f) => f.group === "home").map(strip), pricing: faq.filter((f) => f.group === "pricing").map(strip) },
    posts: present.filter((r) => r.kind === "post").map(val),
  };
}

export async function publishWebsite(admin: AdminUser) {
  if (!process.env.SITE_PUBLISH_SCRIPT) {
    throw badRequest("Publishing is not set up on this server: SITE_PUBLISH_SCRIPT is missing from the admin panel's environment.");
  }
  await expireStaleBuilds();

  const result = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pratibha.website_publish'))`;
    const running = await tx.sitePublish.findFirst({ where: { status: "building" } });
    if (running) throw conflict("A publish is already building. Wait for it to finish, then publish again.");

    const rows = await tx.siteEntry.findMany();
    const changed = rows.filter((r) => !same(r.draft, r.live));
    if (!changed.length) throw badRequest("There is nothing to publish: every draft already matches the website.");

    // First publish of a post fixes its published date.
    const now = new Date().toISOString();
    for (const r of rows) {
      const d = r.draft as Post | null;
      if (r.kind === "post" && d && d.status === "published" && !d.publishedAt) {
        r.draft = { ...d, publishedAt: now } as unknown as Prisma.JsonValue;
        await tx.siteEntry.update({ where: { id: r.id }, data: { draft: r.draft as Prisma.InputJsonValue } });
      }
    }

    const content = assembleContent(rows, "draft");
    const slugs = content.posts.map((p) => p.slug);
    const dup = slugs.find((s, i) => slugs.indexOf(s) !== i);
    if (dup) throw badRequest(`Two posts use /blog/${dup}. Change one before publishing.`);

    for (const r of changed) {
      if (r.draft === null) await tx.siteEntry.delete({ where: { id: r.id } });
    }
    await tx.siteEntry.updateMany({ where: { id: { in: rows.filter((r) => r.draft !== null).map((r) => r.id) } }, data: { publishedAt: new Date() } });
    for (const r of rows) {
      if (r.draft !== null && !same(r.draft, r.live)) {
        await tx.siteEntry.update({ where: { id: r.id }, data: { live: r.draft as Prisma.InputJsonValue } });
      }
    }

    const publish = await tx.sitePublish.create({
      data: { status: "building", content: content as unknown as Prisma.InputJsonValue, changes: changed.length, startedBy: admin.id },
    });
    await recordActivity(
      {
        actor: admin,
        action: "website.published",
        summary: `${admin.name} published ${changed.length} website ${changed.length === 1 ? "change" : "changes"}`,
        after: { publishId: publish.id, changes: changed.map((r) => `${r.kind}:${r.key}`) },
      },
      tx
    );
    return { publishId: publish.id, content, count: changed.length };
  });

  startBuild(result.publishId, result.content);
  return { message: `Publishing ${result.count} ${result.count === 1 ? "change" : "changes"}. The website updates in about a minute.`, publishId: result.publishId };
}

/** Rebuild the site from the latest published content (after a failed build). */
export async function retryPublish(admin: AdminUser) {
  if (!process.env.SITE_PUBLISH_SCRIPT) throw badRequest("Publishing is not set up on this server.");
  await expireStaleBuilds();
  const publish = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('pratibha.website_publish'))`;
    if (await tx.sitePublish.findFirst({ where: { status: "building" } })) throw conflict("A publish is already building.");
    const rows = await tx.siteEntry.findMany();
    const content = assembleContent(rows, "live");
    const p = await tx.sitePublish.create({
      data: { status: "building", content: content as unknown as Prisma.InputJsonValue, changes: 0, startedBy: admin.id },
    });
    await recordActivity({ actor: admin, action: "website.rebuilt", summary: `${admin.name} rebuilt the website from its published content`, after: { publishId: p.id } }, tx);
    return { id: p.id, content };
  });
  startBuild(publish.id, publish.content);
  return { message: "Rebuilding the website. It updates in about a minute.", publishId: publish.id };
}

export async function publishStatus(id: string) {
  await expireStaleBuilds();
  const p = await db.sitePublish.findUnique({ where: { id }, select: { status: true, log: true, finishedAt: true } });
  if (!p) throw notFound();
  return p;
}

