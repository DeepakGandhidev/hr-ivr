import { NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  // Session bootstrap: which user is this, and which tenant do they belong to?
  const dbUser = await adminPrisma.user.findUnique({
    where: { authProviderId: user.id },
    include: { tenant: { select: { id: true, name: true, slug: true, status: true } } },
  });

  if (!dbUser) {
    return NextResponse.json({ user: null }, { status: 404 });
  }

  return NextResponse.json({
    user: {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      role: dbUser.role,
      tenant: dbUser.tenant,
    },
  });
}
