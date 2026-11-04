import { inlineJson, saarthiConfig } from "@/lib/saarthi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /saarthi.js — the one line the marketing site includes.
 *
 * The marketing site is a static export, so it cannot read the admin panel.
 * Shipping the chat through this tiny script means the site key, the widget
 * address and the on/off switch all live in Platform settings: change them
 * there and the website follows within a few minutes, with no rebuild.
 * When the chat is off it is an empty script.
 */
export function GET() {
  const config = saarthiConfig();
  const body = config.publicOn
    ? `(() => {
  if (window.Saarthi && (window.Saarthi.version || window.Saarthi.q)) return;
  window.Saarthi = { q: [["init", { siteKey: ${inlineJson(config.siteKey)} }]] };
  var s = document.createElement("script");
  s.src = ${inlineJson(config.widgetUrl)};
  s.async = true;
  document.body.appendChild(s);
})();
`
    : "/* Saarthi chat is off. */\n";

  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Short, so a change in the admin panel reaches visitors quickly.
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}
