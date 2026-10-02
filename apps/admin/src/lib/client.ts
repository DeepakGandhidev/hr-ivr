"use client";

/**
 * The browser's one way to call the admin API.
 *
 * A 401 means the session ended (idle, expired, revoked, deactivated): the page
 * goes to sign in and says so, rather than showing a broken form.
 */
export class ApiCallError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data?.error === "SESSION_ENDED") {
    window.location.href = "/sign-in?expired=1";
    throw new ApiCallError(401, "SESSION_ENDED", data.message ?? "Your session has ended.");
  }
  if (!res.ok) {
    throw new ApiCallError(res.status, data?.error ?? "ERROR", data?.message ?? "Something went wrong.");
  }
  return data as T;
}
