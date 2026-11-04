import Link from "next/link";
import { notFound } from "next/navigation";
import type { PromptTemplateKey } from "@pratibha/prisma";
import { requireAdminPage } from "@/lib/auth/session";
import { can, refusalReason } from "@/lib/auth/roles";
import { PROMPTS, promptVersions } from "@/lib/prompts-admin";
import { PromptEditor } from "./PromptEditor";

export const dynamic = "force-dynamic";

export default async function PromptPage({ params }: { params: { key: string } }) {
  const { admin } = await requireAdminPage();
  const meta = PROMPTS.find((p) => p.key === params.key);
  if (!meta) notFound();
  const versions = await promptVersions(meta.key as PromptTemplateKey);

  return (
    <>
      <Link href="/prompts" className="back">← AI prompts</Link>
      <PromptEditor
        meta={meta}
        versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
        canEdit={can(admin.role, "prompts.edit")}
        refusal={refusalReason(admin.role, "prompts.edit")}
      />
    </>
  );
}
