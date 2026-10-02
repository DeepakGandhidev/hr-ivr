import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/session";
import { panelContext } from "@/lib/panel-context";
import { db } from "@/lib/db";
import { workspaceDetail } from "@/lib/workspaces";
import { inr, inrPaise, num, shortDate, longDate, ago } from "@/lib/format";
import { METHOD_LABEL, sellerIdentity } from "@/lib/ledger";
import { gstStateCode } from "@pratibha/shared";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { WorkspaceHeader, SubscriptionActions, MemberMenu, DeleteCard } from "./DetailActions";

export const dynamic = "force-dynamic";

export default async function WorkspaceDetailPage({ params }: { params: { id: string } }) {
  const { admin, session } = await requireAdminPage();
  const detail = await workspaceDetail(params.id);
  if (!detail || detail.tenant.status === "deleted") notFound();
  const { tenant, allowance, usage, jobs, owner } = detail;

  const [ctx, activity, payments, requester] = await Promise.all([
    panelContext(admin, session),
    db.activityLog.findMany({ where: { targetWorkspaceId: tenant.id }, orderBy: { at: "desc" }, take: 4 }),
    db.payment.findMany({ where: { tenantId: tenant.id }, orderBy: { paidAt: "desc" }, take: 3 }),
    tenant.deletionRequestedBy ? db.adminUser.findUnique({ where: { id: tenant.deletionRequestedBy } }) : null,
  ]);

  const sub = tenant.subscription;
  const coupon = sub?.couponRedemptions[0]?.coupon ?? null;
  const onTrial = tenant.status === "trial";
  const minutesOut = allowance.minutes > 0 && usage.minutesUsed >= allowance.minutes;
  const profile = tenant.companyProfile;
  const seller = sellerIdentity();
  const sameState = profile?.billingState && gstStateCode(profile.billingState) === gstStateCode(seller.state);
  const members = tenant.users.filter((u) => !u.removedAt);
  const ws = { id: tenant.id, name: tenant.name, status: tenant.status, planKey: tenant.plan.key, planName: tenant.plan.name };

  return (
    <>
      <Link href="/workspaces" className="back">← Workspaces</Link>
      <WorkspaceHeader ws={ws} ctx={ctx} chip={detail.statusChip} />

      {tenant.status === "suspended" && (
        <div className="notice notice-error">
          Suspended {tenant.statusChangedAt ? shortDate(tenant.statusChangedAt) : ""}. Members see: “This workspace is paused.
          Write to start@pratibha.tech to resolve it.”
        </div>
      )}

      <div className="grid-4">
        <div className="kpi">
          <div className="kpi-value sm">{onTrial ? "Trial" : `${tenant.plan.name} · ${inr(tenant.plan.priceInr)}`}</div>
          <div className="kpi-label">
            {onTrial
              ? `Ends ${shortDate(tenant.trialEndsAt)}`
              : `Since ${shortDate(sub?.createdAt ?? tenant.createdAt)}${coupon ? `, via coupon ${coupon.code}` : ""}${tenant.plan.version > 1 ? ` · version ${tenant.plan.version}` : ""}`}
          </div>
        </div>
        <div className="kpi">
          <div className={`kpi-value sm${minutesOut ? " warn" : ""}`}>{num(usage.minutesUsed)} of {num(allowance.minutes)}</div>
          <div className="kpi-label">
            Minutes used{minutesOut ? " · now running as overage" : ""}
            {sub?.topUpMinutes ? ` · ${num(sub.topUpMinutes)} added` : ""}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-value sm">{num(usage.screeningsUsed)} of {num(allowance.screenings)}</div>
          <div className="kpi-label">CV screenings used</div>
        </div>
        <div className="kpi">
          <div className="kpi-value sm">{jobs.total} {jobs.total === 1 ? "job" : "jobs"}</div>
          <div className="kpi-label">{jobs.live} live · {num(jobs.candidatesInPlay)} candidates in play</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad" style={{ gap: 12 }}>
          <div className="card-title">Subscription</div>
          <SubscriptionActions ws={ws} ctx={ctx}
            summary={onTrial ? `Trial · ${num(allowance.minutes)} minutes` : `${tenant.plan.name} · ${inr(tenant.plan.priceInr)} · ${num(tenant.plan.minutes)} minutes`} />
          <div className="card-foot">
            {onTrial || !sub
              ? "No invoice until the trial converts."
              : `Next invoice ${inr(tenant.plan.priceInr)} on ${shortDate(sub.periodEnd)} · `}
            {!onTrial && sub && (profile?.gstin
              ? `billed to GSTIN ${profile.gstin}, ${profile.billingState ?? "state not set"} · ${sameState ? "IGST does not apply, CGST plus SGST" : "IGST, the customer is in another state"}`
              : "no GSTIN on file, so the invoice carries none")}
          </div>
        </div>

        <div className="card card-pad">
          <div className="card-row">
            <div className="grow card-title">Members · {members.length}</div>
          </div>
          {members.map((m) => (
            <div key={m.id} className="card-row" style={{ fontSize: 13.5 }}>
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="cell-strong">{m.name ?? m.email.split("@")[0]}</span> · {m.email}
                {!m.authProviderId && <span className="cell-sub"> · invited, not joined</span>}
              </span>
              <span className={`chip ${m.role === "owner" ? "chip-indigo" : "chip-neutral"}`}>{m.role.charAt(0).toUpperCase() + m.role.slice(1)}</span>
              {ctx.allowed["workspace.members"] && (
                <MemberMenu wsId={tenant.id} member={{ id: m.id, email: m.email, name: m.name, role: m.role, joined: Boolean(m.authProviderId) }} />
              )}
            </div>
          ))}
          <div className="card-foot">Admin can reset a member&apos;s password link or remove a member; both email the workspace owner.</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad" style={{ gap: 9 }}>
          <div className="card-title">Recent activity in this workspace</div>
          {activity.length === 0 && <div className="hint">Nothing recorded yet.</div>}
          {activity.map((a) => (
            <div key={String(a.id)} style={{ fontSize: 13, color: "var(--ink-body)" }}>
              {a.summary}{a.reason ? `, reason: ${a.reason}` : ""} <span className="cell-muted">· {ago(a.at)}</span>
            </div>
          ))}
          <div className="card-foot" style={{ paddingTop: 8 }}>
            <Link href={`/activity?workspace=${tenant.id}`} style={{ fontWeight: 600, textDecoration: "none" }}>Everything for this workspace →</Link>
          </div>
        </div>
        <div className="card card-pad" style={{ gap: 9 }}>
          <div className="card-title">Payments</div>
          {payments.length === 0 && <div className="hint">No payments recorded.</div>}
          {payments.map((p) => (
            <div key={p.id} className="card-row" style={{ fontSize: 13, color: "var(--ink-body)" }}>
              <span className="grow">{shortDate(p.paidAt)} · {p.description}{p.method !== "none" ? ` · ${METHOD_LABEL[p.method] ?? p.method}` : ""}{p.status !== "captured" ? ` · ${p.status.replace("_", " ")}` : ""}</span>
              <span style={{ fontWeight: 600 }}>{inrPaise(p.amountPaise)}</span>
            </div>
          ))}
          <div className="card-foot" style={{ paddingTop: 8 }}>
            <Link href={`/payments?workspace=${tenant.id}`} style={{ fontWeight: 600, textDecoration: "none" }}>All payments and invoices →</Link>
          </div>
        </div>
      </div>

      <DeleteCard
        ws={ws}
        ctx={ctx}
        me={admin.id}
        status={tenant.status}
        request={tenant.deletionRequestedBy ? { by: requester?.name ?? "an admin", byId: tenant.deletionRequestedBy, at: tenant.deletionRequestedAt?.toISOString() ?? null } : null}
        holdUntil={tenant.deletionHoldUntil ? longDate(tenant.deletionHoldUntil) : null}
      />
      <div className="hint" style={{ textAlign: "right" }}>
        Owner {owner ? `${owner.name ?? ""} <${owner.email}>` : "not set"} · /{tenant.slug} · joined {longDate(tenant.createdAt)}
        {ROLE_LABEL[admin.role] ? "" : ""}
      </div>
    </>
  );
}
