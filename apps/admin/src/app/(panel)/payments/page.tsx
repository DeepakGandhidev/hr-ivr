import Link from "next/link";
import { requireAdminPage } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { paymentCounts, paymentWhere, REFUND_GROUNDS, type PaymentFilter } from "@/lib/payments-admin";
import { livePacks, packLabel } from "@/lib/pricing";
import { METHOD_LABEL } from "@/lib/ledger";
import { inrPaise, num, shortDate } from "@/lib/format";
import { PaymentMenu, RecordPaymentButton } from "./PaymentActions";
import { autopaySummary, gatewayInfo } from "@/lib/autopay-admin";

export const dynamic = "force-dynamic";

const COLS = "90px minmax(0, 1fr) minmax(0, 1fr) 110px 110px 150px 130px 40px";
const FILTERS: { key: PaymentFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "captured", label: "Captured" },
  { key: "failed", label: "Failed" },
  { key: "refunded", label: "Refunded" },
];

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: { q?: string; filter?: string; workspace?: string; page?: string };
}) {
  const { admin } = await requireAdminPage();
  const q = searchParams.q?.trim() || undefined;
  const workspace = searchParams.workspace || undefined;
  const filter = (FILTERS.find((f) => f.key === searchParams.filter)?.key ?? "all") as PaymentFilter;
  const pageSize = Math.max(5, Number(await getSetting("lists.page_size")) || 25);
  const counts = await paymentCounts({ q, workspace });
  const total = counts[filter];
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(searchParams.page) || 1));

  const gateway = gatewayInfo();
  const [rows, workspaces, packs, scoped, autopay] = await Promise.all([
    db.payment.findMany({
      where: paymentWhere({ q, filter, workspace }),
      orderBy: { paidAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { tenant: { select: { id: true, name: true } }, invoice: { select: { id: true, number: true } } },
    }),
    db.tenant.findMany({
      where: { status: { in: ["active", "past_due", "suspended", "trial"] } },
      orderBy: { name: "asc" },
      include: { plan: true },
    }),
    livePacks(),
    workspace ? db.tenant.findUnique({ where: { id: workspace }, select: { name: true } }) : null,
    autopaySummary(),
  ]);

  const href = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, filter, workspace, page, ...over })) {
      if (v === undefined || v === "" || (k === "filter" && v === "all") || (k === "page" && v === 1)) continue;
      p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Payments</h1>
          <p className="page-sub">
            Every charge, refund and invoice across the platform{scoped ? `, for ${scoped.name}` : ""}.
            {scoped && <> <Link href="/payments">Show all</Link></>}
          </p>
        </div>
        {can(admin.role, "payments.record") && (
          <RecordPaymentButton
            defaultWorkspace={workspace}
            workspaces={workspaces.map((w) => ({ id: w.id, name: w.name, status: w.status, planName: w.plan.name, priceInr: w.plan.priceInr, version: w.plan.version }))}
            packs={packs.map((p) => ({ id: p.id, label: packLabel(p), priceInr: p.priceInr }))}
          />
        )}
      </div>

      <div className="card card-pad" style={{ gap: 10, marginBottom: 16 }}>
        <div className="card-row">
          <div className="grow card-title">Cashfree AutoPay</div>
          {gateway.provider === "cashfree" ? (
            <span className={`chip ${gateway.mode === "production" ? "chip-green" : "chip-amber"}`}>
              {gateway.mode === "production" ? "Live" : "Sandbox"}
            </span>
          ) : (
            <span className="chip chip-neutral">Not connected · manual billing</span>
          )}
        </div>
        <div className="grid-4">
          <div className="kpi"><div className="kpi-value sm">{num(autopay.mandates.active)}</div><div className="kpi-label">Mandates active</div></div>
          <div className="kpi"><div className="kpi-value sm">{num(autopay.mandates.pending)}</div><div className="kpi-label">Awaiting customer approval</div></div>
          <div className="kpi"><div className="kpi-value sm">{num(autopay.inFlight.length)}</div><div className="kpi-label">Renewals being charged</div></div>
          <div className="kpi"><div className={`kpi-value sm${autopay.retrying ? " warn" : ""}`}>{num(autopay.retrying)}</div><div className="kpi-label">Failed AutoPay charges</div></div>
        </div>
        {autopay.inFlight.length > 0 && (
          <div style={{ display: "grid", gap: 6 }}>
            {autopay.inFlight.map((r) => (
              <div key={r.tenant.id} className="card-row" style={{ fontSize: 13 }}>
                <Link href={`/workspaces/${r.tenant.id}`} className="grow cell-strong" style={{ textDecoration: "none" }}>{r.tenant.name}</Link>
                <span className="cell-muted">due {shortDate(r.dueOn)}</span>
                {r.invoice && <Link href={`/payments/invoices/${r.invoice.id}`} style={{ fontWeight: 600 }}>{r.invoice.number}</Link>}
                {r.invoice && <span style={{ fontWeight: 600 }}>{inrPaise(r.invoice.totalPaise)}</span>}
                <span className={`chip ${r.payment?.status === "failed" ? "chip-red" : "chip-amber"}`}>
                  {r.payment?.status === "failed"
                    ? r.payment.retryAt ? `Failed · retry ${shortDate(r.payment.retryAt)}` : "Failed · chase manually"
                    : r.payment?.status === "scheduled_retry" ? "Retrying" : "Debit scheduled"}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="card-foot">
          Customers set up AutoPay from Subscription in the portal. Renewals are charged three days before the period ends and
          land here as captured or failed by themselves; a failed one retries daily for a week.
        </div>
      </div>

      <form className="toolbar" action="/payments">
        <input type="search" name="q" defaultValue={q} placeholder="Search workspace or invoice number" aria-label="Search payments" className="input search" />
        {workspace && <input type="hidden" name="workspace" value={workspace} />}
        {filter !== "all" && <input type="hidden" name="filter" value={filter} />}
        <div className="pills">
          {FILTERS.map((f) => (
            <Link key={f.key} href={`/payments${href({ filter: f.key, page: 1 })}`} className={`pill${filter === f.key ? " on" : ""}`}>
              {f.label} · {num(counts[f.key])}
            </Link>
          ))}
        </div>
        <div className="grow" />
        {can(admin.role, "payments.export") && (
          <a className="btn md" href={`/api/payments/export${href({ page: undefined })}`}>Export CSV</a>
        )}
      </form>

      <div className="table">
        <div className="trow head" style={{ gridTemplateColumns: COLS }}>
          <div>Date</div><div>Workspace</div><div>For</div><div>Amount</div><div>Method</div><div>Status</div><div>Invoice</div><div />
        </div>
        {rows.length === 0 && (
          <div className="empty">
            <strong>{counts.all === 0 && !q ? "No payments yet" : "Nothing matches"}</strong>
            <span>{counts.all === 0 && !q ? "Record the first one when a customer pays." : "Try another search or filter."}</span>
          </div>
        )}
        {rows.map((p) => {
          const failed = p.status === "failed" || p.status === "scheduled_retry";
          const chip =
            p.status === "captured"
              ? { tone: "green", label: p.kind === "refund" ? "Refund paid" : "Captured" }
              : p.status === "refunded"
                ? { tone: "neutral", label: "Refunded" }
                : p.status === "scheduled_retry" && !p.retryAt
                  ? { tone: "amber", label: "Retrying" }
                  : { tone: "red", label: p.retryAt ? `Failed · retry ${shortDate(p.retryAt)}` : "Failed" };
          return (
            <div key={p.id} className={`trow${failed ? " highlight" : ""}`} style={{ gridTemplateColumns: COLS, fontSize: 13 }}>
              <div className="cell-muted">{shortDate(p.paidAt)}</div>
              <Link href={`/workspaces/${p.tenant.id}`} className="cell-strong" style={{ textDecoration: "none" }}>{p.tenant.name}</Link>
              <div>
                {p.description}
                {p.discountPaise > 0 && <div className="cell-sub">after {inrPaise(p.discountPaise)} coupon discount</div>}
                {p.reason && p.kind !== "subscription" && p.kind !== "top_up" && <div className="cell-sub">{p.reason}</div>}
              </div>
              <div style={{ fontWeight: 600 }}>{p.kind === "refund" ? "−" : ""}{inrPaise(p.amountPaise)}</div>
              <div className="cell-muted">
                {METHOD_LABEL[p.method] ?? p.method}
                {!p.recordedBy && p.kind !== "goodwill" && p.kind !== "refund" && <div className="cell-sub">AutoPay</div>}
              </div>
              <div><span className={`chip chip-${chip.tone}`}>{chip.label}</span></div>
              <div>{p.invoice ? <Link href={`/payments/invoices/${p.invoice.id}`} style={{ fontWeight: 600 }}>{p.invoice.number}</Link> : <span className="cell-muted">—</span>}</div>
              <PaymentMenu
                payment={{ id: p.id, kind: p.kind, status: p.status, description: p.description, amount: inrPaise(p.amountPaise) }}
                canRefund={can(admin.role, "payments.refund")}
                canRecord={can(admin.role, "payments.record")}
                grounds={REFUND_GROUNDS.map((g) => ({ key: g.key, label: g.label }))}
              />
            </div>
          );
        })}
        <div className="tfoot">
          <span>
            Showing {from} to {to} of {num(total)} · Invoices carry the workspace&apos;s GSTIN and split CGST plus SGST or IGST by
            state. Refunds follow the published refund policy and are logged with a reason.
          </span>
          <div className="grow" />
          {page > 1 ? <Link className="btn sm" href={`/payments${href({ page: page - 1 })}`}>Previous</Link> : <span className="btn sm" aria-disabled="true">Previous</span>}
          {page < pages ? <Link className="btn sm" href={`/payments${href({ page: page + 1 })}`}>Next</Link> : <span className="btn sm" aria-disabled="true">Next</span>}
        </div>
      </div>

      {gateway.provider !== "cashfree" && (
        <div className="notice">
          Until Cashfree is connected, charges are recorded here manually with a Record payment action, so the ledger stays
          complete from day one.
        </div>
      )}
    </>
  );
}
