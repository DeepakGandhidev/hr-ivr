import { inlineJson, saarthiConfig } from "@/lib/saarthi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /app-chat.html — the Saarthi chat screen of the Pratibha mobile app.
 *
 * The app shows this page full screen in a WebView. When Saarthi starts a chat
 * the page asks the app for a token (postMessage), the app fetches one from
 * /api/<workspace>/saarthi-token with its own login, and hands it back. The
 * page never sees the app's login and the SDK secret never leaves the server.
 * Opened in an ordinary browser it only says what it is.
 *
 * From the Saarthi integration guide (step 7), with the site key and widget
 * address taken from the admin panel instead of being pasted in.
 */
export function GET() {
  const config = saarthiConfig();
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="robots" content="noindex">
<title>Pratibha Help</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center; padding: 24px; box-sizing: border-box; text-align: center;
    font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; color: #374151;
  }
  button {
    font: inherit; font-weight: 600; margin-top: 12px; padding: 10px 20px;
    border: 0; border-radius: 10px; background: #4f46e5; color: #fff;
  }
</style>
</head>
<body>
<main id="status" aria-live="polite">Opening the chat…</main>
<script>
(() => {
  const SITE_KEY = ${inlineJson(config.siteKey)};
  const WIDGET = ${inlineJson(config.widgetUrl)};
  const ENABLED = ${inlineJson(config.portalOn)};
  const app = window.ReactNativeWebView; // only inside the app's WebView
  const status = document.getElementById('status');

  if (!app) {
    status.textContent = 'This is the chat screen of the Pratibha app.';
    return;
  }
  if (!ENABLED) {
    status.textContent = 'Chat isn’t available right now.';
    return;
  }

  // The app adds #user=<id> to this address. Read it, then clean the address:
  // Saarthi records the page address on each conversation.
  let userId = '';
  try {
    userId = decodeURIComponent((/[#&]user=([^&]*)/.exec(location.hash) || [])[1] || '');
  } catch {}
  history.replaceState(null, '', location.pathname + location.search);

  try {
    // A chat kept on this phone for someone else (after a logout) is forgotten, never shown.
    const key = 'saarthi:' + SITE_KEY + ':session';
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    if (stored && (!userId || stored.userId !== userId)) localStorage.removeItem(key);
    // Opens the chat by itself once it is ready.
    sessionStorage.setItem('saarthi:' + SITE_KEY + ':open', '1');
  } catch {}

  // Saarthi asks for a sign-in token each time it starts a chat; the app gets one from the server.
  const waiting = new Map();
  window.saarthiTokenFromApp = (id, token) => {
    const request = waiting.get(id);
    if (!request) return;
    waiting.delete(id);
    clearTimeout(request.timer);
    if (token) request.resolve(token);
    else request.reject(new Error('no token'));
  };
  const getEndUserToken = () =>
    new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error('the app did not answer'));
      }, 15000);
      waiting.set(id, { resolve, reject, timer });
      app.postMessage(JSON.stringify({ type: 'saarthi-token', id }));
    });

  window.Saarthi = { q: [['init', { siteKey: SITE_KEY, getEndUserToken }]] };

  const load = () => {
    status.textContent = 'Opening the chat…';
    const slow = setTimeout(() => {
      status.textContent = 'Still connecting… The first time can take up to a minute.';
    }, 6000);
    const script = document.createElement('script');
    script.src = WIDGET;
    script.async = true;
    script.onload = () => {
      clearTimeout(slow);
      status.textContent = 'Need help? Tap the chat button.';
    };
    script.onerror = () => {
      clearTimeout(slow);
      script.remove();
      status.textContent = 'Couldn’t open the chat. Check your connection.';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.onclick = load;
      status.append(document.createElement('br'), retry);
    };
    document.body.append(script);
  };
  load();
})();
</script>
</body>
</html>
`;

  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
