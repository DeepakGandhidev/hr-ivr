#!/usr/bin/env node
/**
 * Load the website's current content into the admin panel, once.
 *
 *   node apps/admin/scripts/import-website-content.mjs <site>/src/content/defaults.json
 *
 * Creates a row (draft and live) for every page, the company details, each
 * testimonial, FAQ item and post in the file. A row that already exists is
 * left alone, so running it again never overwrites edits made in the panel.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@pratibha/prisma";

const file = process.argv[2];
if (!file) {
  console.error("usage: import-website-content.mjs <content.json>");
  process.exit(1);
}
const content = JSON.parse(readFileSync(file, "utf8"));
const url = process.env.ADMIN_APP_DATABASE_URL ?? process.env.DATABASE_URL;
const db = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);

const rows = [];
for (const [key, page] of Object.entries(content.pages ?? {})) rows.push({ kind: "page", key, position: 0, data: page });
if (content.company) rows.push({ kind: "company", key: "company", position: 0, data: content.company });
(content.testimonials ?? []).forEach((t, i) => rows.push({ kind: "testimonial", key: t.id, position: i, data: t }));
for (const group of ["home", "pricing"]) {
  (content.faq?.[group] ?? []).forEach((f, i) => rows.push({ kind: "faq", key: f.id, position: i, data: { ...f, group } }));
}
(content.posts ?? []).forEach((p, i) => rows.push({ kind: "post", key: p.id, position: i, data: p }));

let created = 0;
for (const r of rows) {
  const exists = await db.siteEntry.findUnique({ where: { kind_key: { kind: r.kind, key: r.key } } });
  if (exists) continue;
  await db.siteEntry.create({
    data: { kind: r.kind, key: r.key, position: r.position, draft: r.data, live: r.data, publishedAt: new Date() },
  });
  created++;
}
await db.activityLog.create({
  data: {
    actorType: "system",
    action: "website.imported",
    summary: `Imported the website's content into the admin panel (${created} new of ${rows.length} items)`,
  },
});
console.log(`Imported ${created} new of ${rows.length} items.`);
await db.$disconnect();
