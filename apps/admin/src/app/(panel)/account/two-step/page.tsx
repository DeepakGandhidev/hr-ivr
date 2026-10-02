import { requireAdminPage } from "@/lib/auth/session";
import { TwoStepSetup } from "./TwoStepSetup";

export const dynamic = "force-dynamic";

export default async function TwoStepPage() {
  const { admin } = await requireAdminPage();
  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1 className="page-title">Two step verification</h1>
          <p className="page-sub">A code from an authenticator app on your phone, asked at sign in and before Sign in as.</p>
        </div>
      </div>
      <div className="card card-pad" style={{ maxWidth: 620 }}>
        {admin.totpEnabledAt ? (
          <>
            <div className="card-row">
              <div className="grow card-title">Two step verification is on</div>
              <span className="chip chip-green">On</span>
            </div>
            <div className="hint">
              Turned on {admin.totpEnabledAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.
              If you lose your phone, an Owner can reset it from Admin team.
            </div>
          </>
        ) : (
          <TwoStepSetup />
        )}
      </div>
    </>
  );
}
