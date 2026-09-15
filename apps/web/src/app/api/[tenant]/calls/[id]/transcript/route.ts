import { NextRequest } from "next/server";
import { Action, NotFoundError } from "@pratibha/shared";
import { withTenantAuth } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";

interface StoredTurn {
  speaker: "pratibha" | "candidate";
  text: string;
  atMs: number;
}

/**
 * One call's transcript.
 *
 * Its own endpoint rather than a field on the calls list: the list can hold 500
 * rows, and a transcript is the entire conversation. Sending them all to render
 * a table that shows none of the text made the list payload megabytes.
 *
 * The transcript is candidate personal data. It is read through the tenant
 * transaction like everything else, so row-level security scopes it to the
 * caller's tenant, and it lives on the call row, which cascades on candidate
 * deletion — the existing deletion flow covers it with no extra step.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(() =>
    withTenantAuth(tenant, Action.candidateRead, async (_ctx, tx) => {
      const call = await tx.interviewCall.findUnique({
        where: { id },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          status: true,
          language: true,
          transcript: true,
          recordingRef: true,
          candidate: {
            select: { id: true, name: true, email: true, job: { select: { id: true, title: true } } },
          },
        },
      });

      // RLS would already refuse a call belonging to another tenant; this turns
      // that into an honest 404 rather than a null the client has to guess at.
      if (!call) throw new NotFoundError("Call not found");

      return {
        call: {
          id: call.id,
          startedAt: call.startedAt,
          endedAt: call.endedAt,
          status: call.status,
          language: call.language,
          candidate: call.candidate,
          recordingRef: call.recordingRef,
        },
        turns: normaliseTurns(call.transcript),
      };
    })
  );
}

/**
 * The stored transcript, defensively.
 *
 * It is a JSON column written by the worker, so its shape is a convention
 * rather than a guarantee — an older row, a partial write or a schema change
 * would otherwise crash the page that renders it. Anything unrecognised is
 * dropped rather than rendered as "undefined".
 */
function normaliseTurns(stored: unknown): StoredTurn[] {
  if (!Array.isArray(stored)) return [];

  return stored.flatMap((entry): StoredTurn[] => {
    if (!entry || typeof entry !== "object") return [];
    const turn = entry as Record<string, unknown>;

    const speaker = turn.speaker === "candidate" ? "candidate" : turn.speaker === "pratibha" ? "pratibha" : null;
    const text = typeof turn.text === "string" ? turn.text.trim() : "";
    if (!speaker || !text) return [];

    return [{ speaker, text, atMs: typeof turn.atMs === "number" ? turn.atMs : 0 }];
  });
}
