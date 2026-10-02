import { redirect, notFound } from "next/navigation";
import { lookupSession, panelEnabled } from "@/lib/auth/session";
import { Brand } from "@/components/Brand";
import { CodeForm } from "./CodeForm";

export const dynamic = "force-dynamic";

export default async function CodePage() {
  if (!panelEnabled()) notFound();
  const found = await lookupSession();
  if (found.state === "active") redirect("/");
  if (found.state !== "awaiting_code") redirect("/sign-in?expired=1");

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Brand />
        <div>
          <h1 className="page-title">Two step code</h1>
          <p className="page-sub">Enter the six digit code from your authenticator app for {found.admin.email}.</p>
        </div>
        <CodeForm />
      </div>
    </div>
  );
}
