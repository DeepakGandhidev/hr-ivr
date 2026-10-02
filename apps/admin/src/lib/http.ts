import { NextResponse, type NextRequest } from "next/server";
import type { ZodSchema } from "zod";

/**
 * An expected refusal: wrong role, missing reason, a state that does not allow
 * the action. Carries the sentence the UI shows, so the panel never has to
 * invent its own explanation for a server decision.
 */
export class AdminApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AdminApiError(400, "BAD_REQUEST", message, details);
export const forbidden = (message: string) => new AdminApiError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found") => new AdminApiError(404, "NOT_FOUND", message);
export const conflict = (message: string) => new AdminApiError(409, "CONFLICT", message);

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof AdminApiError) {
    return NextResponse.json(
      { error: error.code, message: error.message, details: error.details },
      { status: error.status }
    );
  }
  console.error("[admin] unhandled API error", error);
  return NextResponse.json(
    { error: "INTERNAL_ERROR", message: "Something went wrong on our side. Nothing was changed." },
    { status: 500 }
  );
}

/**
 * Mutations are same-origin only. The session cookie is already SameSite=Strict;
 * this is the second lock, for a browser that gets that wrong.
 */
export function assertSameOrigin(request: NextRequest) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("origin");
  if (!origin) return; // Non-browser clients (scripts, tests) send none; the cookie still has to be valid.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    if (new URL(origin).host !== host) throw forbidden("Cross-site request refused.");
  } catch (e) {
    if (e instanceof AdminApiError) throw e;
    throw forbidden("Cross-site request refused.");
  }
}

export async function handle(request: NextRequest, fn: () => Promise<unknown>): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const result = await fn();
    if (result instanceof NextResponse) return result;
    return NextResponse.json(result ?? { ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function parseBody<T>(request: NextRequest, schema: ZodSchema<T>): Promise<T> {
  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(first?.message ?? "Invalid request", parsed.error.flatten());
  }
  return parsed.data;
}

/** A typed reason: the thing every sensitive action must carry. */
export function requireReason(reason: string | null | undefined, what = "this action"): string {
  const r = (reason ?? "").trim();
  if (r.length < 4) throw badRequest(`Type a reason for ${what}. It is recorded in the activity log.`);
  if (r.length > 500) throw badRequest("Keep the reason under 500 characters.");
  return r;
}
