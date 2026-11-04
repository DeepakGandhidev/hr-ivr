import { saarthiConfig } from "@/lib/saarthi";

/**
 * Keep Saarthi's widget server awake while the chat is on.
 *
 * Saarthi currently runs on a host that sleeps after 15 quiet minutes, and the
 * first visitor after that waits up to a minute before the chat bubble appears
 * (most leave first). A light request every 10 minutes keeps it awake. It
 * costs one small download per interval and does nothing while the chat is
 * off; remove it once Saarthi moves to an always-on host.
 */
const EVERY_MS = 10 * 60 * 1000;

export function startSaarthiKeepAlive() {
  const ping = () => {
    const { publicOn, portalOn, widgetUrl } = saarthiConfig();
    if (!publicOn && !portalOn) return;
    void fetch(widgetUrl, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(90_000) })
      .then((r) => r.body?.cancel())
      .catch(() => {
        // A sleeping host that does not answer in time is woken by the attempt anyway.
      });
  };
  setTimeout(ping, 30_000);
  setInterval(ping, EVERY_MS).unref?.();
}
