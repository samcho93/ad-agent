import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import { loadSettings } from "@/core/settings";

export interface StructuredRequest<S extends z.ZodType> {
  purpose: string;
  system: string;
  user: string;
  schema: S;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  stopReason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  costUsd?: number;
}

/** 테스트에서는 가짜 생성기로 바꿔 끼운다 */
export type Generator = <S extends z.ZodType>(req: StructuredRequest<S>) => Promise<StructuredResult<z.infer<S>>>;

export class GenerationError extends Error {}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // 키는 환경 변수(.env.local)에서만 읽는다. 코드·로그·케이스 폴더에 남기지 않는다.
  client ??= new Anthropic();
  return client;
}

export const anthropicGenerator: Generator = async (req) => {
  const s = loadSettings().llm;
  let msg;
  try {
    // max_tokens가 커서 SDK가 스트리밍을 요구한다. 이벤트는 쓰지 않고 최종 메시지만 받는다.
    msg = await getClient().beta.messages.stream({
      model: s.model,
      max_tokens: s.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: s.effort, format: zodOutputFormat(req.schema) },
      // 안전 분류기가 거절하면 서버가 다른 모델로 이어서 처리한다
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new GenerationError("Anthropic API 키가 없거나 올바르지 않습니다 (.env.local 의 ANTHROPIC_API_KEY 확인)");
    if (e instanceof Anthropic.RateLimitError) throw new GenerationError("API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요");
    if (e instanceof Anthropic.APIError) throw new GenerationError(`API 오류 (${e.status ?? "연결"}): ${e.message}`);
    if (e instanceof Error && /api key|apiKey|authentication/i.test(e.message)) throw new GenerationError("Anthropic API 키가 설정되지 않았습니다 (.env.local 의 ANTHROPIC_API_KEY)");
    throw e;
  }
  if (msg.stop_reason === "refusal") throw new GenerationError("모델이 요청을 거절했습니다");
  if (msg.stop_reason === "max_tokens") throw new GenerationError("출력이 max_tokens에서 잘렸습니다 (config/settings.json 의 llm.maxTokens 확인)");
  if (msg.parsed_output == null) throw new GenerationError("모델 출력을 스키마로 읽지 못했습니다");
  return {
    data: msg.parsed_output as z.infer<typeof req.schema>,
    model: msg.model,
    stopReason: msg.stop_reason,
    usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
  };
};
