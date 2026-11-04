import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SETTINGS, SETTINGS_BY_KEY } from "@pratibha/shared/settings-registry";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { CANDIDATE_STATUSES, CANDIDATE_STATUS_LABELS, candidateStatusLabel } from "@pratibha/shared";
import { COPY_VARS } from "../../../packages/shared/src/registry/copy";
import { AUTH_COPY_PREFIXES, copyFor, copyText, PORTAL_COPY_PREFIXES } from "@/lib/copy";
import { fill, placeholdersIn } from "@/lib/copy-fill";
import { CopyProvider, renderRich } from "@/lib/copy-client";
import { CandidateStatusBadge } from "@/components/CandidateStatus";
import { shortlistBody } from "@/lib/notifications";
import { emailChangeRequestedEmail, passwordChangedEmail } from "@/lib/copy-emails";

const SRC = path.resolve(__dirname, "../src");
const COPY = SETTINGS.filter((d) => d.group === "copy");

function panel(rows: Record<string, unknown>) {
  return startSettings({
    app: "web",
    load: async () => Object.entries(rows).map(([key, value]) => ({ key, value })),
    intervalMs: 3_600_000,
  });
}

afterEach(() => __resetSettingsRuntime());

// ------------------------------------------------------------ source scan

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return p.includes(`${path.sep}api`) && p.endsWith(`${path.sep}api`) ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

/** The text of a balanced {...} starting at `open`. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error("unbalanced");
}

/** Top-level property names of an object literal body. */
function propNames(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const m = part.trim().match(/^([A-Za-z_$][\w$]*)\s*(:|$)/);
    if (m) names.push(m[1]);
  }
  return names;
}

interface Use {
  file: string;
  key: string;
  vars: string[] | null;
}

const files = sourceFiles(SRC);
const uses: Use[] = files.flatMap((file) => {
  const src = fs.readFileSync(file, "utf8");
  const out: Use[] = [];
  for (const m of Array.from(src.matchAll(/"(copy\.[\w.]*\w)"/g))) {
    const after = src.slice(m.index! + m[0].length);
    const objAt = after.match(/^\s*(?::\s*"copy\.[\w.]+"\s*)?,\s*\{/);
    out.push({
      file,
      key: m[1],
      vars: objAt ? propNames(balanced(after, objAt[0].length - 1)) : null,
    });
  }
  return out;
});

/** The worker's source, for the texts only the worker reads. */
const workerSource = (() => {
  const root = path.resolve(__dirname, "../../worker/src");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out.join("\n");
})();

describe("copy registry", () => {
  it("has a non-empty default, a web reader and a copy. key for every entry", () => {
    expect(COPY.length).toBeGreaterThan(200);
    for (const def of COPY) {
      expect(def.key.startsWith("copy."), def.key).toBe(true);
      expect(String(def.default).trim(), def.key).not.toBe("");
      // Portal text, or worker text (the emails the call line sends).
      expect(def.apps.includes("web") || def.apps.includes("worker"), def.key).toBe(true);
      expect(["text", "textarea"]).toContain(def.type);
      expect(String(def.default).length).toBeLessThanOrEqual(def.maxLength!);
      expect(def.section, def.key).toBeTruthy();
      expect(def.help, def.key).toBeTruthy();
    }
  });

  it("declares every placeholder a default uses, and names them in the help", () => {
    for (const def of COPY) {
      const used = placeholdersIn(String(def.default));
      for (const v of used) expect(COPY_VARS[def.key] ?? [], `${def.key} uses {${v}}`).toContain(v);
      for (const v of COPY_VARS[def.key] ?? []) expect(def.help, def.key).toContain(`{${v}}`);
    }
  });

  it("passes the saved defaults through validation unchanged", async () => {
    const { validateSettingValue } = await import("@pratibha/shared/settings-registry");
    for (const def of COPY) {
      const r = validateSettingValue(def, def.default);
      expect(r.ok && r.value, def.key).toBe(def.default);
    }
  });
});

describe("copy keys in the code", () => {
  it("are all registered, and every registered key is used", () => {
    expect(uses.length).toBeGreaterThan(200);
    const used = new Set(uses.map((u) => u.key));
    for (const key of Array.from(used)) expect(SETTINGS_BY_KEY[key]?.group, key).toBe("copy");
    for (const def of COPY) {
      if (def.key.startsWith("copy.status.")) continue; // read through candidateStatusLabel
      // Worker text is read by the worker, not the portal.
      if (!def.apps.includes("web")) {
        expect(workerSource.includes(`'${def.key}'`), `${def.key} is never read by the worker`).toBe(true);
        continue;
      }
      expect(used.has(def.key), `${def.key} is never read`).toBe(true);
    }
  });

  it("fill every placeholder their default uses", () => {
    for (const u of uses) {
      const needed = placeholdersIn(String(SETTINGS_BY_KEY[u.key].default));
      if (!needed.length) continue;
      expect(u.vars, `${u.key} in ${path.relative(SRC, u.file)} passes no values`).not.toBeNull();
      for (const v of needed) expect(u.vars, `${u.key} in ${path.relative(SRC, u.file)} needs {${v}}`).toContain(v);
      for (const v of COPY_VARS[u.key] ?? []) expect(u.vars, `${u.key} should pass {${v}}`).toContain(v);
    }
  });

  it("in client components are under a prefix their layout provides", () => {
    for (const u of uses) {
      const src = fs.readFileSync(u.file, "utf8");
      if (!/^\s*["']use client["']/.test(src)) continue;
      const rel = path.relative(SRC, u.file);
      const auth = /^app[\\/](login|signup|verify-email|reset-password)[\\/]/.test(rel);
      const prefixes = auth ? AUTH_COPY_PREFIXES : PORTAL_COPY_PREFIXES;
      expect(prefixes.some((p) => u.key.startsWith(p)), `${u.key} in ${rel}`).toBe(true);
    }
  });

  it("never pull the server runtime into a client component", () => {
    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/.test(src)) continue;
      expect(src, file).not.toMatch(/settings-runtime|from "@\/lib\/copy"|from "@\/lib\/copy-emails"/);
    }
  });
});

describe("with nothing saved the wording is unchanged", () => {
  it("keeps the shipped text", async () => {
    await panel({});
    expect(copyText("copy.auth.login.title")).toBe("Welcome back");
    expect(copyText("copy.auth.login.no_account")).toBe("Don't have an account?");
    expect(copyText("copy.auth.signup.password_help", { min: 8 })).toBe("At least 8 characters.");
    expect(copyText("copy.public.job.interview_line", { company: "Acme", job: "QA" })).toBe(
      "Interested? Shortlisted candidates will be invited to a short telephonic interview with Pratibha, our AI recruiter."
    );
    expect(copyText("copy.public.careers.no_roles", { company: "Acme" })).toBe("No open roles right now. Check back soon.");
    expect(copyText("copy.portal.overview.summary", { applications: "1 application", interviews: "2 interviews" })).toBe(
      "Pratibha has read 1 application and completed 2 interviews."
    );
    expect(copyText("copy.portal.jobs.no_match_archived", { query: "qa" })).toBe("No archived roles match “qa”.");
    expect(copyText("copy.portal.pipeline.mode_line", { used: 3, allowance: 50 })).toBe(
      "Auto screens matched applications as they arrive. Manual queues them for you. 3 of 50 screenings used this month."
    );
    expect(copyText("copy.portal.overview.funnel_heading")).toBe("This month’s pipeline");
  });

  it("keeps the shortlist email body", async () => {
    await panel({});
    const input = { candidateName: "Asha", jobTitle: "QA Engineer", score: 82, reasonSummary: "Strong on Selenium.", tenantName: "Acme" };
    expect(shortlistBody(input, "https://x.test/acme/jobs/1/shortlist")).toBe(
      [
        "Asha scored 82 against QA Engineer and is now on the draft shortlist.",
        "",
        "Strong on Selenium.",
        "",
        "They have not been contacted. Approve the shortlist and press Request interview to send them an invite:",
        "https://x.test/acme/jobs/1/shortlist",
        "",
        "— Pratibha, for Acme",
      ].join("\n")
    );
  });

  it("keeps the account emails", async () => {
    await panel({});
    const change = emailChangeRequestedEmail({ name: "Deepak", oldEmail: "a@x.test", newEmail: "b@x.test" });
    expect(change.subject).toBe("A change of email address was requested on your Pratibha account");
    expect(change.body).toBe(
      `Hello Deepak,\n\n` +
        `Someone asked to change the email address on your Pratibha account ` +
        `from a@x.test to b@x.test. It will not take effect until ` +
        `the new address is confirmed.\n\n` +
        `If this was not you, change your password now and contact your ` +
        `workspace owner.\n`
    );
    const pw = passwordChangedEmail({ name: null, email: "a@x.test" });
    expect(pw.subject).toBe("Your Pratibha password was changed");
    expect(pw.body).toBe(
      `Hello,\n\n` +
        `The password on your Pratibha account (a@x.test) was just changed, ` +
        `and every other signed-in device was signed out.\n\n` +
        `If this was you, there is nothing to do.\n\n` +
        `If it was not, your account is at risk: reset your password immediately ` +
        `and contact your workspace owner.\n`
    );
  });

  it("keeps status names, client and server", async () => {
    await panel({});
    const map = copyFor(PORTAL_COPY_PREFIXES);
    for (const s of CANDIDATE_STATUSES) {
      expect(candidateStatusLabel(s, map)).toBe(CANDIDATE_STATUS_LABELS[s]);
      const html = renderToStaticMarkup(
        <CopyProvider copy={map}>
          <CandidateStatusBadge status={s} />
        </CopyProvider>
      );
      expect(html).toContain(`>${CANDIDATE_STATUS_LABELS[s]}<`);
    }
  });

  it("renders the bold notices as they were", async () => {
    await panel({});
    const html = renderToStaticMarkup(
      <>{renderRich(copyText("copy.portal.subscription.cancel_warning", { date: "1/11/2026", days: 30 }))}</>
    );
    expect(html).toBe(
      "<strong>What happens:</strong> you keep full access until 1/11/2026. After that your workspace becomes " +
        "<strong>read-only</strong> — you can still read candidates, transcripts and reports, but not run new " +
        "interviews. <strong>30 days later the data is deleted</strong> and cannot be recovered."
    );
  });
});

describe("with wording saved in the panel", () => {
  it("uses it everywhere, server and client", async () => {
    await panel({
      "copy.auth.login.title": "Namaste",
      "copy.status.advance_stage": "Final round",
      "copy.email.shortlist.signoff": "Cheers, {company}",
    });
    expect(copyText("copy.auth.login.title")).toBe("Namaste");
    expect(copyFor(AUTH_COPY_PREFIXES)["copy.auth.login.title"]).toBe("Namaste");
    expect(candidateStatusLabel("advance_stage", copyFor(PORTAL_COPY_PREFIXES))).toBe("Final round");
    const body = shortlistBody(
      { candidateName: "A", jobTitle: "J", score: 1, reasonSummary: "r", tenantName: "Acme" },
      "link"
    );
    expect(body.endsWith("Cheers, Acme")).toBe(true);
  });

  it("falls back to the original when the saved value is blank", async () => {
    await panel({ "copy.auth.login.title": "   " });
    expect(copyText("copy.auth.login.title")).toBe("Welcome back");
  });

  it("copyFor only carries the asked-for prefixes", async () => {
    await panel({});
    const keys = Object.keys(copyFor(AUTH_COPY_PREFIXES));
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.every((k) => k.startsWith("copy.auth."))).toBe(true);
  });
});

describe("fill", () => {
  it("fills known placeholders and leaves unknown ones visible", () => {
    expect(fill("Hi {name}, {x}", { name: "A" })).toBe("Hi A, {x}");
    expect(fill("{n} of {n}", { n: 2 })).toBe("2 of 2");
    expect(fill("no vars {a}")).toBe("no vars {a}");
  });
});
