import { requireAdminPage } from "@/lib/auth/session";
import { can, ROLE_LABEL } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { when } from "@/lib/format";
import { InviteAdminButton, TeamMenu } from "./TeamActions";

export const dynamic = "force-dynamic";

const COLS = "minmax(0, 1fr) 130px 130px 160px 40px";
const ROLE_TONE = { owner: "amber", engineer: "indigo", support: "neutral" } as const;

/** Verbatim from the Admin team board. */
const ROLES_FOOTER =
  "Owner does everything. Engineer sees everything and edits Platform settings, but cannot publish pricing or delete workspaces. Support can look, sign in as a workspace with a reason, and grant goodwill minutes up to a cap, nothing else. Two step verification is required before any role can use Sign in as.";

export default async function TeamPage() {
  const { admin } = await requireAdminPage();
  const admins = await db.adminUser.findMany({ orderBy: [{ deactivatedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }] });
  const manage = can(admin.role, "team.manage");

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Admin team</h1>
          <p className="page-sub">Who can open this panel, and how much of it.</p>
        </div>
        {manage && <InviteAdminButton />}
      </div>
      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <div>Admin</div><div>Role</div><div>Two step</div><div>Last active</div><div />
        </div>
        {admins.map((a) => {
          const pending = !a.passwordHash && !a.deactivatedAt;
          return (
            <div key={a.id} className={`trow${a.deactivatedAt ? " dim" : ""}`} style={{ gridTemplateColumns: COLS, fontSize: 13.5 }}>
              <div>
                <span className="cell-strong">{a.name}</span> · {a.email}
                {a.id === admin.id && <span className="cell-sub"> · you</span>}
                {pending && <span className="cell-sub"> · invited, not joined</span>}
                {a.deactivatedAt && <span className="cell-sub"> · deactivated</span>}
              </div>
              <div><span className={`chip chip-${ROLE_TONE[a.role]}`}>{ROLE_LABEL[a.role]}</span></div>
              <div>{a.totpEnabledAt ? <span className="chip chip-green">On</span> : <span className="chip chip-red">Off</span>}</div>
              <div className="cell-muted">{a.lastActiveAt ? when(a.lastActiveAt) : "Never"}</div>
              {manage && a.id !== admin.id ? (
                <TeamMenu target={{ id: a.id, name: a.name, role: a.role, deactivated: Boolean(a.deactivatedAt), twoStep: Boolean(a.totpEnabledAt), pending }} />
              ) : <div />}
            </div>
          );
        })}
        <div className="tfoot">{ROLES_FOOTER}</div>
      </div>
    </>
  );
}
