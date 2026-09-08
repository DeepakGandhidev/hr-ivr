export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function uniqueJobSlug(
  tenantId: string,
  title: string,
  exists: (where: { tenantId_slug: { tenantId: string; slug: string } }) => Promise<unknown>
): Promise<string> {
  let base = slugify(title) || "job";
  let slug = base;
  let suffix = 2;

  while (await exists({ tenantId_slug: { tenantId, slug } })) {
    slug = `${base}-${suffix}`;
    suffix++;
  }

  return slug;
}
