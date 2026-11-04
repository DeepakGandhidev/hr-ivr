import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { AdminUser } from "@pratibha/prisma";
import { recordActivity } from "@/lib/activity";
import { badRequest, notFound } from "@/lib/http";

/**
 * Images uploaded in the Website section.
 *
 * Stored in SITE_UPLOADS_DIR on this server and copied into the site as
 * /uploads/<name> on every Publish (deploy/website-publish.sh). The name is a
 * hash of the bytes, so an image never changes under its URL (nginx serves
 * them as immutable) and the same image uploaded twice is stored once.
 *
 * Only PNG, JPEG and WebP, checked by their bytes, not the name or the type the
 * browser claims: these are served from pratibha.tech, the dashboard's origin,
 * so an SVG or HTML file must never get through.
 */

export const MAX_UPLOAD_BYTES = 1_000_000; // the admin host's nginx refuses bodies over 1 MB
const NAME = /^[a-f0-9]{20}\.(png|jpg|webp)$/;

export function uploadsDir() {
  return process.env.SITE_UPLOADS_DIR ?? "/var/agents/pratibha-uploads";
}

type Kind = { ext: "png" | "jpg" | "webp"; type: string };

export function sniffImage(buf: Buffer): Kind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", type: "image/png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", type: "image/webp" };
  }
  return null;
}

export async function saveUpload(admin: AdminUser, buf: Buffer) {
  if (!buf.length) throw badRequest("The image was empty.");
  if (buf.length > MAX_UPLOAD_BYTES) throw badRequest("Images can be up to 1 MB. The upload button shrinks them for you; try that.");
  const kind = sniffImage(buf);
  if (!kind) throw badRequest("Use a PNG, JPG or WebP image.");

  const name = `${createHash("sha256").update(buf).digest("hex").slice(0, 20)}.${kind.ext}`;
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!existsSync(file)) {
    writeFileSync(file, buf, { mode: 0o644 });
    await recordActivity({
      actor: admin,
      action: "website.image_uploaded",
      summary: `${admin.name} uploaded an image (${Math.round(buf.length / 1024)} KB)`,
      after: { path: `/uploads/${name}` },
    });
  }
  return { path: `/uploads/${name}`, bytes: buf.length, message: "Image uploaded. It goes live with your next Publish." };
}

export function readUpload(name: string): { buf: Buffer; type: string } {
  if (!NAME.test(name)) throw notFound();
  const file = path.join(uploadsDir(), name);
  if (!existsSync(file)) throw notFound();
  const buf = readFileSync(file);
  const kind = sniffImage(buf);
  if (!kind) throw notFound();
  return { buf, type: kind.type };
}

/** Every uploaded image, newest first, for the image library. */
export function listUploads(): { path: string; name: string; bytes: number; at: string }[] {
  const dir = uploadsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => NAME.test(n))
    .map((n) => {
      const s = statSync(path.join(dir, n));
      return { path: `/uploads/${n}`, name: n, bytes: s.size, at: s.mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}
