import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where tenant files live.
 *
 * An interface with one driver today, for the same reason the payment gateway
 * is an interface: the storage decision is not final. Local disk works on the
 * current single server and needs no credentials; an S3 driver is a new
 * implementation of this contract and a config change, not a rebuild.
 *
 * Callers only ever hold a `key`. Nothing outside this module knows whether
 * that is a path, an object key or a row id, which is what keeps the swap
 * cheap — and what stops a browser-reachable path leaking into the database and
 * bypassing the tenant-scoped route that serves these files.
 *
 * Known limitation of the local driver, stated because it will matter: files
 * live on the server's disk, so they are outside the database backup and do not
 * survive rebuilding the box. Moving to object storage is the fix; until then
 * a logo is re-uploadable, which is why this is acceptable for logos and photos
 * and would not be for anything irreplaceable.
 */
export interface StoredObject {
  key: string;
  contentType: string;
  byteSize: number;
}

export interface StorageDriver {
  put(args: {
    tenantId: string;
    /** Groups objects; the local driver uses it as a directory. */
    prefix: string;
    body: Buffer;
    contentType: string;
    filename?: string;
  }): Promise<StoredObject>;

  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;

  delete(key: string): Promise<void>;
}

/** Where the local driver writes. Overridable so a test never touches it. */
const ROOT = process.env.TENANT_ASSET_DIR ?? "/var/agents/pratibha-assets";

/**
 * Keys are `<tenantId>/<prefix>/<uuid><ext>`.
 *
 * The tenant id is the first segment so a stray key is still traceable to an
 * owner, and the random name means an uploaded filename never reaches the
 * filesystem — user-supplied names are how path traversal gets in.
 */
function buildKey(tenantId: string, prefix: string, contentType: string): string {
  const ext = EXTENSIONS[contentType] ?? "bin";
  return `${tenantId}/${prefix}/${randomUUID()}.${ext}`;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

/**
 * Refuse a key that could escape the root.
 *
 * Keys are generated here, so this should never fire — which is exactly why it
 * is checked: the day a key comes from somewhere else, this is the difference
 * between a bug and reading /etc/passwd.
 */
function resolveWithinRoot(key: string): string {
  const full = path.resolve(ROOT, key);
  const root = path.resolve(ROOT);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error("Refusing a storage key that escapes the asset root");
  }
  return full;
}

export const localStorageDriver: StorageDriver = {
  async put({ tenantId, prefix, body, contentType }) {
    const key = buildKey(tenantId, prefix, contentType);
    const full = resolveWithinRoot(key);

    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);

    return { key, contentType, byteSize: body.byteLength };
  },

  async get(key) {
    try {
      const body = await readFile(resolveWithinRoot(key));
      return { body, contentType: contentTypeFor(key) };
    } catch {
      // A missing file is a 404 for the caller, not a crash: an asset row can
      // outlive its bytes if storage was swapped or a restore was partial.
      return null;
    }
  },

  async delete(key) {
    try {
      await unlink(resolveWithinRoot(key));
    } catch {
      // Already gone is the desired end state.
    }
  },
};

function contentTypeFor(key: string): string {
  const ext = path.extname(key).slice(1).toLowerCase();
  const found = Object.entries(EXTENSIONS).find(([, e]) => e === ext);
  return found?.[0] ?? "application/octet-stream";
}

export const storage: StorageDriver = localStorageDriver;

// --- Upload validation ------------------------------------------------------

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"] as const;

/** 2 MB. A logo that needs more than this is a logo nobody optimised. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export interface ImageCheck {
  ok: boolean;
  error?: string;
}

/**
 * Whether an uploaded image is acceptable.
 *
 * The declared content type is checked against the bytes rather than trusted:
 * a browser sends whatever it likes, and "image/png" on a file that is actually
 * HTML is the oldest upload bug there is.
 *
 * SVG is accepted because Gaurav asked for it, and it is the one format here
 * that can carry script. It is therefore never served inline — the asset route
 * sends it with a content type and disposition that stop the browser executing
 * it in our origin.
 */
export function checkImageUpload(body: Buffer, declaredType: string): ImageCheck {
  if (!(IMAGE_TYPES as readonly string[]).includes(declaredType)) {
    return { ok: false, error: "Use a PNG, JPG, SVG or WebP image." };
  }
  if (body.byteLength === 0) return { ok: false, error: "That file is empty." };
  if (body.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: "Images must be 2 MB or smaller." };
  }

  const sniffed = sniffImageType(body);
  if (!sniffed) return { ok: false, error: "That file is not a readable image." };
  if (sniffed !== declaredType) {
    return { ok: false, error: "That file's contents do not match its type." };
  }

  return { ok: true };
}

/** Magic numbers, plus a narrow check for SVG's text format. */
export function sniffImageType(body: Buffer): string | null {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString("ascii") === "RIFF" &&
    body.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // SVG has no magic number. Only the leading, non-whitespace start of the file
  // is examined, so a PNG with "<svg" somewhere in its pixel data is not one.
  const head = body.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }

  return null;
}

/** Stable identifier for cache validation on the asset route. */
export function etagFor(body: Buffer): string {
  return `"${createHash("sha1").update(body).digest("hex")}"`;
}

// --- Lifecycle --------------------------------------------------------------

/**
 * Minimal client shape, so this works with a transaction handle as well as the
 * admin client.
 */
interface AssetDb {
  tenantAsset: {
    findUnique(args: { where: { id: string }; select: { storageKey: true } }): Promise<{ storageKey: string } | null>;
    findMany(args: { where: { tenantId: string }; select: { id: true; storageKey: true } }): Promise<Array<{ id: string; storageKey: string }>>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    deleteMany(args: { where: { tenantId: string } }): Promise<unknown>;
  };
}

/**
 * Delete one asset: the row and the bytes.
 *
 * Called when a logo or photo is replaced. Without it every replacement leaves
 * the previous file on disk forever, with no row pointing at it — the classic
 * way an assets directory grows without bound and nobody can tell what is still
 * in use.
 *
 * Never throws. It runs after the replacement has already been saved, so a
 * failure here is a stray file, not a failed request.
 */
export async function deleteAsset(db: AssetDb, assetId: string): Promise<void> {
  try {
    const asset = await db.tenantAsset.findUnique({
      where: { id: assetId },
      select: { storageKey: true },
    });
    if (!asset) return;

    await db.tenantAsset.delete({ where: { id: assetId } });
    await storage.delete(asset.storageKey);
  } catch {
    // Left for a future sweep; the user's action already succeeded.
  }
}

/**
 * Remove every file belonging to a tenant.
 *
 * The rows cascade on their own when a tenant is deleted — the bytes do not.
 * Deleting the tenant first and the files never is how personal data survives
 * a deletion request, so this exists to be called by the deletion flow, before
 * the cascade removes the index that says which files were theirs.
 */
export async function purgeTenantAssets(db: AssetDb, tenantId: string): Promise<number> {
  const assets = await db.tenantAsset.findMany({
    where: { tenantId },
    select: { id: true, storageKey: true },
  });

  for (const asset of assets) {
    await storage.delete(asset.storageKey);
  }

  await db.tenantAsset.deleteMany({ where: { tenantId } });
  return assets.length;
}
