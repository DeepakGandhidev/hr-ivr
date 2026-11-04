/**
 * Cashfree's checkout SDK, for the browser. Loaded only when someone is about
 * to pay, so no page carries a third-party script it does not need.
 */

declare global {
  interface Window {
    Cashfree?: (opts: { mode: string }) => {
      subscriptionsCheckout: (opts: { subsSessionId: string; redirectTarget: string }) => Promise<{ error?: { message?: string } }>;
    };
  }
}

function loadCashfree(): Promise<NonNullable<Window["Cashfree"]>> {
  if (window.Cashfree) return Promise.resolve(window.Cashfree);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
    script.onload = () => (window.Cashfree ? resolve(window.Cashfree) : reject(new Error("Cashfree did not load")));
    script.onerror = () => reject(new Error("Could not reach Cashfree. Check your connection and try again."));
    document.head.appendChild(script);
  });
}

/** Open the subscription checkout in this tab. Resolves with an error message, if any. */
export async function openSubscriptionCheckout(sessionId: string, mode: string): Promise<string | null> {
  const cashfree = (await loadCashfree())({ mode });
  const result = await cashfree.subscriptionsCheckout({ subsSessionId: sessionId, redirectTarget: "_self" });
  return result?.error ? result.error.message || "Checkout did not open" : null;
}

/** Open the one-time payment checkout (top-ups, upgrades) in this tab. */
export async function openPaymentCheckout(paymentSessionId: string, mode: string): Promise<string | null> {
  const cashfree = (await loadCashfree())({ mode }) as unknown as {
    checkout: (opts: { paymentSessionId: string; redirectTarget: string }) => Promise<{ error?: { message?: string } }>;
  };
  const result = await cashfree.checkout({ paymentSessionId, redirectTarget: "_self" });
  return result?.error ? result.error.message || "Checkout did not open" : null;
}
