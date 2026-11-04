import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/activity";
import type { SiteContent } from "@/lib/website/schema";

/**
 * Run the site build for one publish, in the background.
 *
 * SITE_PUBLISH_SCRIPT (deploy/website-publish.sh in this repo, installed on the
 * server) builds the marketing site from a content file and swaps the result
 * into the folder nginx serves. This process waits for it and records the
 * outcome on the site_publishes row; if this process dies first, the row is
 * expired as failed after BUILD_TIMEOUT_MS and Retry runs it again.
 */

export const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const LOG_LIMIT = 6000;

export function startBuild(publishId: string, content: SiteContent) {
  const script = process.env.SITE_PUBLISH_SCRIPT!;
  const dir = process.env.SITE_CONTENT_DIR ?? path.join(path.dirname(script), "content");

  let log = "";
  const append = (chunk: Buffer | string) => {
    log = (log + chunk.toString()).slice(-LOG_LIMIT);
  };

  const finish = async (ok: boolean, extra?: string) => {
    if (extra) append(`\n${extra}`);
    try {
      await db.sitePublish.update({
        where: { id: publishId },
        data: { status: ok ? "live" : "failed", log: log.trim() || null, finishedAt: new Date() },
      });
      if (!ok) {
        await recordActivity({
          actorType: "system",
          action: "website.build_failed",
          summary: "The website build failed. The site still shows the previous version.",
          after: { publishId },
        });
      }
    } catch (error) {
      console.error("[admin] could not record website build result", error);
    }
  };

  let file: string;
  try {
    mkdirSync(dir, { recursive: true });
    file = path.join(dir, `content-${publishId}.json`);
    writeFileSync(file, JSON.stringify(content, null, 2));
  } catch (error) {
    void finish(false, `Could not write the content file: ${(error as Error).message}`);
    return;
  }

  // A clean environment: this app's own NODE_ENV, database URLs and Next.js
  // internals (__NEXT_*) must not leak into the site's separate Next build.
  const pass = ["PATH", "HOME", "LANG", "SITE_SRC", "SITE_TARGET", "SITE_OWNER", "SITE_UPLOADS_DIR", "npm_config_cache"];
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PUBLISH_ID: publishId };
  for (const k of pass) if (process.env[k]) env[k] = process.env[k];

  const child = spawn("bash", [script, file], { stdio: ["ignore", "pipe", "pipe"], env });
  const timer = setTimeout(() => {
    append("\nThe build took too long and was stopped.");
    child.kill("SIGTERM");
  }, BUILD_TIMEOUT_MS - 60_000);

  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (error) => {
    clearTimeout(timer);
    void finish(false, `Could not start the build: ${error.message}`);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    void finish(code === 0, code === 0 ? undefined : `Build exited with code ${code}.`);
  });
}
