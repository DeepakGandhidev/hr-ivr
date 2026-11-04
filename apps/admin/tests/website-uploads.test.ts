import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn(async () => {}) }));

import { readUpload, saveUpload, sniffImage } from "@/lib/website/uploads";

const admin = { id: "a1", name: "Tester" } as any;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(32, 3)]);

beforeAll(() => {
  process.env.SITE_UPLOADS_DIR = mkdtempSync(path.join(tmpdir(), "uploads-"));
});

describe("image uploads", () => {
  it("recognises PNG, JPEG and WebP by their bytes", () => {
    expect(sniffImage(png)?.ext).toBe("png");
    expect(sniffImage(jpg)?.ext).toBe("jpg");
    expect(sniffImage(webp)?.ext).toBe("webp");
  });

  it("refuses SVG and HTML whatever they are called", async () => {
    await expect(saveUpload(admin, Buffer.from('<svg onload="alert(1)"/>'))).rejects.toThrow(/PNG, JPG or WebP/);
    await expect(saveUpload(admin, Buffer.from("<html><script>x</script>"))).rejects.toThrow(/PNG, JPG or WebP/);
  });

  it("refuses files over 1 MB", async () => {
    const big = Buffer.concat([png, Buffer.alloc(1_000_001)]);
    await expect(saveUpload(admin, big)).rejects.toThrow(/1 MB/);
  });

  it("names a file by its content and stores the same image once", async () => {
    const a = await saveUpload(admin, png);
    const b = await saveUpload(admin, png);
    expect(a.path).toMatch(/^\/uploads\/[a-f0-9]{20}\.png$/);
    expect(b.path).toBe(a.path);
    expect(readdirSync(process.env.SITE_UPLOADS_DIR!)).toHaveLength(1);
    expect(readUpload(a.path.slice("/uploads/".length)).type).toBe("image/png");
  });

  it("will not read outside the uploads folder", () => {
    expect(() => readUpload("../../etc/passwd")).toThrow();
    expect(() => readUpload("x.svg")).toThrow();
  });
});
