import { redirect, notFound } from "next/navigation";
import { lookupSession, panelEnabled } from "@/lib/auth/session";
import { Brand } from "@/components/Brand";
import { SignInForm } from "./SignInForm";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: { expired?: string } }) {
  if (!panelEnabled()) notFound();
  const found = await lookupSession();
  if (found.state === "active") redirect("/");
  if (found.state === "awaiting_code") redirect("/sign-in/code");

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand />
        <div>
          <h1 className="page-title">Sign in</h1>
          <p className="page-sub">Pratibha staff only. Customer accounts do not work here.</p>
        </div>
        {searchParams.expired && <div className="notice">Your session ended. Sign in again to carry on.</div>}
        <SignInForm />
      </div>
    </div>
  );
}
