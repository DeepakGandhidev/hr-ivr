import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { promptOverview } from "@/lib/prompts-admin";
import { shortDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PromptsPage() {
  await requireAdminPage();
  const prompts = await promptOverview();

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">AI prompts</h1>
          <p className="page-sub">
            The instructions the AI follows. Every save is a new version; only the live one is used, and any earlier version can be put back.
          </p>
        </div>
      </div>
      <div className="grid-2">
        {prompts.map((p) => (
          <Link key={p.key} href={`/prompts/${p.key}`} className="card card-pad" style={{ textDecoration: "none", color: "inherit" }}>
            <div className="card-row">
              <div className="grow card-title">{p.label}</div>
              {p.active ? <span className="chip sm chip-green">v{p.active.version} live</span> : <span className="chip sm chip-red">None live</span>}
              {p.latest && p.active && p.latest.version > p.active.version && <span className="chip sm chip-amber">Draft v{p.latest.version}</span>}
            </div>
            <div className="hint" style={{ fontSize: 13 }}>{p.usedFor}</div>
            <div className="card-foot">
              {p.versions} {p.versions === 1 ? "version" : "versions"} · used by {p.app}
              {p.active ? ` · live since ${shortDate(p.active.createdAt)}` : ""}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
