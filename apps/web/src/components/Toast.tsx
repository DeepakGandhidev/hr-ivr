"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A short confirmation, such as "Link copied".
 *
 * A live region rather than an alert: it confirms an action the person just
 * took, so it should be announced without interrupting them.
 */
export function useToast(duration = 2600) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (text: string) => {
      setMessage(text);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(null), duration);
    },
    [duration]
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const node = (
    <div className="toast-region" role="status" aria-live="polite">
      {message && <div className="toast">{message}</div>}
    </div>
  );

  return { show, node };
}

/** Clipboard write with the older execCommand path for non-secure origins. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
