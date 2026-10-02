import { NextResponse } from "next/server";
import { adminPrisma } from "@pratibha/prisma";
import { getSessionUser } from "@/lib/authz";

export async function GET() {
  // Shared with every tenant route, so a cookie session and a mobile bearer
  // token resolve the same way here as everywhere else.
  const user = await getSessionUser();

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
