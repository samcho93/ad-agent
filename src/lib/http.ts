import { NextResponse } from "next/server";
import { CaseError } from "@/core/case";
import { GenerationError } from "@/llm/generator";

export function fail(e: unknown) {
  if (e instanceof CaseError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof GenerationError) return NextResponse.json({ error: e.message }, { status: 502 });
  console.error(e instanceof Error ? e.message : "unknown error");
  return NextResponse.json({ error: "서버 오류" }, { status: 500 });
}

export type Ctx = { params: Promise<{ id: string }> };
