import { NextRequest, NextResponse } from "next/server";
import { Action, NotFoundError, ValidationError } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const noteSchema = z.object({
  body: z.string().trim().min(1, "Write something first").max(5000),
});

/**
 * Notes on a candidate.
 *
 * Any team member who can read a candidate may add one — a note is how someone
 * records a judgement, and gating that behind a write role would mean the
 * people who interview are not the people who can record what they thought.
 * Editing and deleting are a different matter, and are the author's alone
 * (see the [noteId] route).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const { tx } = await authorizeTenant(tenant, Action.candidateRead);
    return tx(async (db) => ({
      notes: await db.candidateNote.findMany({
        where: { candidateId: id },
        orderBy: { createdAt: "desc" },
        include: { author: { select: { id: true, name: true, email: true } } },
      }),
    }));
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string } }
) {
  const { tenant, id } = params;
  return handleApi(async () => {
    const parsed = noteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid note", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);

    return tx(async (db) => {
      // Checked explicitly: RLS would reject a cross-tenant candidate id, but
      // as a "not found" at insert time, which reads to the user as the note
      // failing to save for no reason.
      const candidate = await db.candidate.findUnique({ where: { id }, select: { id: true } });
      if (!candidate) throw new NotFoundError("Candidate not found");

      const note = await db.candidateNote.create({
        data: { candidateId: id, authorId: ctx.user.id, body: parsed.data.body },
        include: { author: { select: { id: true, name: true, email: true } } },
      });

      return NextResponse.json({ note }, { status: 201 });
    });
  });
}
