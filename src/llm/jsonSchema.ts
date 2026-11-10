import { z } from "zod/v4";

type Json = Record<string, unknown>;

/**
 * zod 스키마 → 여러 LLM이 받아들이는 JSON Schema.
 * - $schema 같은 메타 키는 뺀다
 * - 모든 object 에 additionalProperties:false, 모든 속성을 required 로 (OpenAI strict 모드 요건)
 * 우리 출력 스키마는 선택 필드가 없으므로 의미가 바뀌지 않는다.
 */
export function toStrictJsonSchema(schema: z.ZodType): Json {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Json;
  return close(raw) as Json;
}

function close(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(close);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === "$schema") continue;
    out[k] = close(v);
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Json);
  }
  return out;
}

/** 모델이 낸 JSON 텍스트를 읽어 스키마로 검증한다 (코드 블록으로 감싼 경우도 처리) */
export function parseJsonOutput<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new Error("모델 출력이 JSON이 아닙니다");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`모델 출력이 스키마와 다릅니다: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
