import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TenantNav } from "@/components/TenantNav";

interface TenantLayoutProps {
  children: React.ReactNode;
  params: { tenant: string };
}

export default async function TenantLayout({ children, params }: TenantLayoutProps) {
  const { tenant } = params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <div className="shell">
      <TenantNav tenant={tenant} />
      <main className="content">{children}</main>
    </div>
  );
}
