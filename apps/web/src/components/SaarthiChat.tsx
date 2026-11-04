"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/** Pages a visitor reaches without signing in; everything else is a workspace page. */
const PUBLIC_PATHS = [/^\/$/, /^\/login\b/, /^\/signup\b/, /^\/verify-email\b/, /^\/reset-password\b/, /^\/forgot-password\b/, /^\/j\//, /^\/careers\//];

type SaarthiApi = {
  version?: string;
  q?: unknown[];
  init?: (options: unknown) => void;
  destroy?: () => void;
};

declare global {
  interface Window {
    Saarthi?: SaarthiApi;
  }
}

/**
 * Saarthi's chat bubble.
 *
 * Rendered twice in the tree on purpose: once in the root layout for public
 * pages (anonymous), once in the workspace layout with a token URL (signed
 * in). The public one stands down on workspace pages, so there is only ever
 * one bubble, and a signed-in member never continues an anonymous chat.
 */
export default function SaarthiChat({
  siteKey,
  widgetUrl,
  tokenUrl,
  publicOnly = false,
}: {
  siteKey: string;
  widgetUrl: string;
  /** Signed-in pages: where to get a fresh token. Omit for an anonymous chat. */
  tokenUrl?: string;
  publicOnly?: boolean;
}) {
  const pathname = usePathname() ?? "/";
  const active = !publicOnly || PUBLIC_PATHS.some((p) => p.test(pathname));

  useEffect(() => {
    if (!active || !siteKey || !widgetUrl) return;

    const options = {
      siteKey,
      // Saarthi asks for a fresh token whenever it starts a chat; each works once.
      ...(tokenUrl && {
        getEndUserToken: () =>
          fetch(tokenUrl, { credentials: "same-origin", cache: "no-store" })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`token ${r.status}`))))
            .then((d: { token?: string }) => d.token),
      }),
    };

    if (window.Saarthi?.version && window.Saarthi.init) {
      window.Saarthi.init(options);
    } else {
      // Not loaded yet: queue the call; the script runs it once it is in.
      window.Saarthi = { q: [["init", options]] };
      if (!document.querySelector(`script[src="${widgetUrl}"]`)) {
        const s = document.createElement("script");
        s.src = widgetUrl;
        s.async = true;
        document.body.appendChild(s);
      }
    }
    return () => window.Saarthi?.destroy?.();
  }, [active, siteKey, widgetUrl, tokenUrl]);

  return null;
}
