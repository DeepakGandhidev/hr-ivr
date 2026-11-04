import { AUTH_COPY_PREFIXES, copyFor } from "@/lib/copy";
import { CopyProvider } from "@/lib/copy-client";

// The wording comes from the admin panel (Text and emails), so this screen is
// rendered per request rather than frozen at build time.
export const dynamic = "force-dynamic";

export default function AuthCopyLayout({ children }: { children: React.ReactNode }) {
  return <CopyProvider copy={copyFor(AUTH_COPY_PREFIXES)}>{children}</CopyProvider>;
}
