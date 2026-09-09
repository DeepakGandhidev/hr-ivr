import { NextRequest } from "next/server";
import { Action, ForbiddenError, NotFoundError, ValidationError } from "@pratibha/shared";
import { authorizeTenant } from "@/lib/authz";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";

const noteSchema = z.object({
  body: z.string().trim().min(1, "Write something first").max(5000),
});

/**
 * Edit and delete are the author's alone.
 *
 * Enforced here rather than only hidden in the UI. A note is one person's
 * written judgement of a named candidate; letting a colleague quietly rewrite
 * it changes the record of who thought what, which is exactly the thing a
 * hiring decision may later have to be defended on. Even an owner does not get
 * to edit someone else's words.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string; noteId: string } }
) {
  const { tenant, id, noteId } = params;
  return handleApi(async () => {
    const parsed = noteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidationError("Invalid note", parsed.error.flatten());
    }

    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);

    return tx(async (db) => {
      const note = await db.candidateNote.findUnique({ where: { id: noteId } });
      if (!note || note.candidateId !== id) throw new NotFoundError("Note not found");
      if (note.authorId !== ctx.user.id) {
        throw new ForbiddenError("Only the author can edit this note");
      }

      return {
        note: await db.candidateNote.update({
          where: { id: noteId },
          data: { body: parsed.data.body },
          include: { author: { select: { id: true, name: true, email: true } } },
        }),
      };
    });
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { tenant: string; id: string; noteId: string } }
) {
  const { tenant, id, noteId } = params;
  return handleApi(async () => {
    const { ctx, tx } = await authorizeTenant(tenant, Action.candidateRead);

    return tx(async (db) => {
      const note = await db.candidateNote.findUnique({ where: { id: noteId } });
      if (!note || note.candidateId !== id) throw new NotFoundError("Note not found");
      if (note.authorId !== ctx.user.id) {
        throw new ForbiddenError("Only the author can delete this note");
      }

      await db.candidateNote.delete({ where: { id: noteId } });
      return { deleted: true };
    });
  });
}
