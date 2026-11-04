import { settingText } from "@pratibha/shared/settings-runtime";
import PublishView from "./PublishView";

/**
 * Publish. The view is a client component; the wording it puts into posts and
 * share links comes from the admin panel (Brand), read here per request.
 */
export default function PublishPage({ params }: { params: { tenant: string; id: string } }) {
  return (
    <PublishView
      tenant={params.tenant}
      id={params.id}
      productName={settingText("brand.product_name", "Pratibha")}
      whatsappShareText={settingText("brand.whatsapp_share_text", "– apply here:")}
    />
  );
}
