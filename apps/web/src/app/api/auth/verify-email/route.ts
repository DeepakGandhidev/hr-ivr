import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { handleApi } from "@/lib/api-errors";
import { z } from "zod";
import { ValidationError } from "@pratibha/shared";

const verifySchema = z.object({
  token: z.string().min(1),
  type: z.enum(["email", "signup", "magiclink", "recovery", "invite"]),
});

export async function POST(request: NextRequest) {
  return handleApi(async () => {
    const body = await request.json();
    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid verification payload", parsed.error.flatten());
    }

    const { token, type } = parsed.data;
    const supabase = createClient();

    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: token,
      type: type as any,
    });

    if (error) {
      return NextResponse.json(
        { error: "VERIFICATION_FAILED", message: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json({ user: data.user });
  });
}
