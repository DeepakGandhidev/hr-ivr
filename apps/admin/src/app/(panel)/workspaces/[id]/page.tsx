import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth/session";
import { panelContext } from "@/lib/panel-context";
import { db } from "@/lib/db";
import { workspaceDetail } from "@/lib/workspaces";
import { inr, inrPaise, num, shortDate, longDate, ago } from "@/lib/format";
import { METHOD_LABEL, sellerIdentity } from "@/lib/ledger";
import { getSetting } from "@/lib/settings";
import { gstStateCode } from "@pratibha/shared";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { MANDATE_CHIP, workspaceAutopay } from "@/lib/autopay-admin";
import { meterPercent } from "@/lib/workspaces";
import { portalUrl } from "@/lib/gotrue";
import { can } from "@/lib/auth/roles";
import { EDIT_PERMISSION } from "@/lib/workspace-edit";
import { companyTab, interviewTab, jobsTab, limitsTab, mailboxesTab } from "@/lib/workspace-edit-data";
import { WorkspaceProfile } from "@/components/WorkspaceProfile";
import { WorkspaceMembers } from "@/components/WorkspaceMembers";
import { WorkspaceJobs } from "@/components/WorkspaceJobs";
import { WorkspaceMailboxes } from "@/components/WorkspaceMailboxes";
import { WorkspaceInterview } from "@/components/WorkspaceInterview";
import { WorkspaceHeader, SubscriptionActions, MemberMenu, DeleteCard } from "./DetailActions";

export const dynamic = "force-dynamic";

/** The detail page's tabs. Overview is the page as it always was; the rest edit what the workspace owns. */
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "workspace", label: "Workspace" },
  { key: "members", label: "Members" },
  { key: "jobs", label: "Jobs" },
  { key: "mailboxes", label: "Mailboxes" },
  { key: "interview", label: "Interview" },
  { key: "limits", label: "Limits and usage" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default async function WorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string };
}) {
  const { admin, session } = await requireAdminPage();
  const detail = await workspaceDetail(params.id);
  if (!detail || detail.tenant.status === "deleted") notFound();
  const { tenant, allowance, usage, jobs, owner } = detail;
  const tab: Tab = TABS.find((t) => t.key === searchParams.tab)?.key ?? "overview";
  // Edits are refused while a workspace is held for deletion; restore it first.
  const canEdit = can(admin.role, EDIT_PERMISSION) && tenant.status !== "deleted_pending";

  const [ctx, activity, payments, requester, autopay] = await Promise.all([
    panelContext(admin, session),
    db.activityLog.findMany({ where: { targetWorkspaceId: tenant.id }, orderBy: { at: "desc" }, take: 4 }),
    db.payment.findMany({ where: { tenantId: tenant.id }, orderBy: { paidAt: "desc" }, take: 3 }),
    tenant.deletionRequestedBy ? db.adminUser.findUnique({ where: { id: tenant.deletionRequestedBy } }) : null,
    workspaceAutopay(tenant.id),
  ]);
  const mandateChip = MANDATE_CHIP[autopay?.mandate?.mandateStatus ?? "none"] ?? MANDATE_CHIP.none;

  const sub = tenant.subscription;
  const coupon = sub?.couponRedemptions[0]?.coupon ?? null;
  const onTrial = tenant.status === "trial";
  const minutesOut = allowance.minutes > 0 && usage.minutesUsed >= allowance.minutes;
  const profile = tenant.companyProfile;
  const [seller, supportEmail] = await Promise.all([sellerIdentity(), getSetting("brand.support_email")]);
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
          Write to {supportEmail || "start@pratibha.tech"} to resolve it.”
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key === "overview" ? `/workspaces/${tenant.id}` : `/workspaces/${tenant.id}?tab=${t.key}`}
            className={tab === t.key ? "on" : undefined}>
            {t.label}
          </Link>
        ))}
      </div>

      {tab !== "overview" && (
        <EditTab tab={tab} tenant={tenant} members={members} canEdit={canEdit} allowance={allowance} usage={usage}
          subscription={<SubscriptionActions ws={ws} ctx={ctx}
            summary={onTrial ? `Trial · ${num(allowance.minutes)} minutes` : `${tenant.plan.name} · ${inr(tenant.plan.priceInr)} · ${num(tenant.plan.minutes)} minutes`} />} />
      )}

      {tab === "overview" && (
      <>

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
          <div className="card-row" style={{ fontSize: 13 }}>
            <span className="grow">
              Cashfree AutoPay
              {autopay?.mandate && (
                <span className="cell-muted">
                  {" "}· {autopay.mandate.brand ?? "method not yet known"} · since {shortDate(autopay.mandate.createdAt)}
                </span>
              )}
              {autopay?.renewal && (
                <span className="cell-muted">
                  {" "}· renewal {autopay.renewal.number} for {inrPaise(autopay.renewal.totalPaise)}{" "}
                  {autopay.renewal.payment?.status === "failed" ? `failed: ${autopay.renewal.payment.reason ?? "no reason given"}` : "being charged"}
                </span>
              )}
            </span>
            <span className={`chip chip-${mandateChip.tone}`}>{mandateChip.label}</span>
          </div>
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
          <div className="card-foot">
            Admin can reset a member&apos;s password link or remove a member; both email the workspace owner.{" "}
            <Link href={`/workspaces/${tenant.id}?tab=members`} style={{ fontWeight: 600, textDecoration: "none" }}>Roles and ownership →</Link>
          </div>
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
      )}
    </>
  );
}

type Detail = NonNullable<Awaited<ReturnType<typeof workspaceDetail>>>;

/** One editing tab. Each reads only what it shows. */
async function EditTab({
  tab,
  tenant,
  members,
  canEdit,
  allowance,
  usage,
  subscription,
}: {
  tab: Exclude<Tab, "overview">;
  tenant: Detail["tenant"];
  members: Detail["tenant"]["users"];
  canEdit: boolean;
  allowance: Detail["allowance"];
  usage: Detail["usage"];
  subscription: React.ReactNode;
}) {
  switch (tab) {
    case "workspace": {
      const company = await companyTab(tenant.id);
      return (
        <WorkspaceProfile ws={{ id: tenant.id, name: tenant.name, slug: tenant.slug, createdAt: longDate(tenant.createdAt) }}
          company={company.profile} states={company.states} limits={company.limits} canEdit={canEdit} portalBase={portalUrl("")} />
      );
    }
    case "members":
      return (
        <WorkspaceMembers wsId={tenant.id} canEdit={canEdit}
          members={members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, joined: Boolean(m.authProviderId), createdAt: shortDate(m.createdAt) }))} />
      );
    case "jobs": {
      const [rows, interview, threshold] = await Promise.all([
        jobsTab(tenant.id),
        interviewTab(tenant.id, tenant.plan.key),
        getSetting("screening.suggest_threshold"),
      ]);
      return (
        <WorkspaceJobs wsId={tenant.id} canEdit={canEdit} workspaceProtocol={interview.protocol} rules={interview.rules}
          defaultThreshold={Number(threshold)} jobLimit={allowance.jobLimit}
          jobs={rows.map((j) => ({ ...j, createdAt: shortDate(j.createdAt), archivedAt: j.archivedAt ? shortDate(j.archivedAt) : null }))} />
      );
    }
    case "mailboxes": {
      const data = await mailboxesTab(tenant.id);
      return (
        <WorkspaceMailboxes wsId={tenant.id} canEdit={canEdit} jobs={data.jobs}
          mailboxes={data.mailboxes.map((m) => ({ ...m, lastChecked: m.lastPollAt ? ago(m.lastPollAt) : "Never" }))} />
      );
    }
    case "interview": {
      const [data, overrides] = await Promise.all([
        interviewTab(tenant.id, tenant.plan.key),
        db.interviewProtocol.count({ where: { tenantId: tenant.id, jobId: { not: null }, job: { deletedAt: null } } }),
      ]);
      return (
        <WorkspaceInterview wsId={tenant.id} canEdit={canEdit} protocol={data.protocol} rules={data.rules}
          updatedAt={data.updatedAt ? ago(data.updatedAt) : null} overrides={overrides} />
      );
    }
    case "limits": {
      const counts = await limitsTab(tenant.id);
      const sub = tenant.subscription;
      const rows = [
        { label: "Interview minutes", used: usage.minutesUsed, allowed: allowance.minutes,
          note: sub?.topUpMinutes ? `includes ${num(sub.topUpMinutes)} added this period` : "plan allowance" },
        { label: "CV screenings", used: usage.screeningsUsed, allowed: allowance.screenings,
          note: sub?.topUpScreenings ? `includes ${num(sub.topUpScreenings)} added this period` : "plan allowance" },
        { label: "Active jobs", used: counts.activeJobs, allowed: allowance.jobLimit, note: "open or paused" },
      ];
      return (
        <div className="grid-2">
          <div className="table">
            <div className="trow head" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 120px" }}>
              <span>Limit</span>
              <span>Used</span>
              <span>Allowed</span>
            </div>
            {rows.map((r) => {
              const pct = r.allowed === null ? 0 : meterPercent(r.used, r.allowed);
              return (
                <div key={r.label} className="trow" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr) 120px", fontSize: 13.5 }}>
                  <span>
                    <span className="cell-strong">{r.label}</span>
                    <div className="cell-sub">{r.note}</div>
                  </span>
                  <span>
                    {num(r.used)}
                    {r.allowed !== null && <div className={`meter${pct >= 100 ? " warn" : ""}`}><div style={{ width: `${pct}%` }} /></div>}
                  </span>
                  <span>{r.allowed === null ? "No limit" : num(r.allowed)}</span>
                </div>
              );
            })}
            <div className="tfoot">
              <span className="grow">
                {num(usage.interviews)} interviews this month · {num(counts.members)} members · {num(counts.mailboxes)} mailboxes.
                Minutes past the allowance run as overage.
              </span>
            </div>
          </div>
          <div className="card card-pad" style={{ gap: 12 }}>
            <div className="card-title">Plan and minutes</div>
            {subscription}
            <div className="card-foot">Limits come from the plan; a plan change or a top up changes them.</div>
          </div>
        </div>
      );
    }
  }
}
