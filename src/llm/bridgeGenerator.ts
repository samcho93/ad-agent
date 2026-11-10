import { z } from "zod/v4";
import type { Effort } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";

export interface BridgeOptions {
  url: string; // 예: http://127.0.0.1:8787
  token: string; // 브리지를 실행하면 화면에 나오는 연결 코드
  model: string;
  effort: Effort;
}

/** 브리지 주소는 이 PC(127.0.0.1/localhost)만 허용한다. 다른 곳으로 프롬프트가 나가지 않게 */
export function normalizeBridgeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new GenerationError("브리지 주소 형식이 올바르지 않습니다 (예: http://127.0.0.1:8787)");
  }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname)) {
    throw new GenerationError("브리지 주소는 이 PC(http://127.0.0.1:포트)만 쓸 수 있습니다");
  }
  return `${u.protocol}//${u.host}`;
}

async function call(url: string, token: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${normalizeBridgeUrl(url)}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new GenerationError("브리지에 연결하지 못했습니다. 이 PC에서 브리지를 실행했는지, 브라우저가 로컬 네트워크 접근을 허용했는지 확인하세요");
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) throw new GenerationError("브리지 연결 코드가 맞지 않습니다 (브리지 화면의 코드를 다시 입력)");
  if (!res.ok) throw new GenerationError(`브리지 오류: ${String(j.error ?? res.status)}`);
  return j;
}

/** Claude CLI 브리지(이 PC에서 실행)에 생성을 맡긴다. 사용자의 Claude Code 로그인으로 실행된다 */
export function createBridgeGenerator(opts: BridgeOptions): Generator {
  if (!opts.token) throw new GenerationError("브리지 연결 코드가 없습니다. 설정에서 입력하세요");
  return async (req) => {
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7" });
    const j = await call(opts.url, opts.token, "/v1/generate", {
      system: req.system,
      user: req.user,
      jsonSchema,
      ...(req.images?.length ? { images: req.images } : {}),
      model: opts.model,
      effort: opts.effort,
    });
    // 예전 브리지는 images 를 모르고 무시한다. 이미지 없이 판단한 결과를 쓰지 않게 막는다
    if (req.images?.length && j.images_seen !== req.images.length) {
      throw new GenerationError("이 브리지 버전은 이미지 검수를 지원하지 않습니다. 브리지 파일을 새로 받아 다시 실행하세요 (0.2.0 이상)");
    }
    const parsed = req.schema.safeParse(j.structured_output);
    if (!parsed.success) {
      throw new GenerationError(`모델 출력이 스키마와 다릅니다: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const usage = (j.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return {
      data: parsed.data,
      model: `${String(j.model ?? opts.model)} (claude-cli)`,
      stopReason: (j.stop_reason as string | null) ?? null,
      usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
      costUsd: typeof j.cost_usd === "number" ? j.cost_usd : undefined,
    };
  };
}

/** 설정 화면의 "연결 확인" */
export async function checkBridge(url: string, token: string): Promise<string> {
  const j = await call(url, token, "/v1/health");
  return `연결됨 (브리지 ${String(j.version)}, ${String(j.claude ?? "claude CLI")})`;
}
