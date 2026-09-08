import { NextResponse } from "next/server";
import { AppError } from "@pratibha/shared";

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      { error: error.code, message: error.message, details: error.details },
      { status: error.statusCode }
    );
  }

  const message = error instanceof Error ? error.message : "Internal server error";
  console.error("API error:", error);
  return NextResponse.json(
    { error: "INTERNAL_ERROR", message },
    { status: 500 }
  );
}

export async function handleApi<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await fn();
    if (data instanceof NextResponse) {
      return data;
    }
    return NextResponse.json(data);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
