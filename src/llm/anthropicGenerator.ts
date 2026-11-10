import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";
import type { Effort } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  maxTokens: number;
}

/**
 * 사용자 본인의 Anthropic API 키로 브라우저에서 직접 호출한다.
 * 키는 사용자 브라우저에만 있고 우리 서버를 거치지 않는다.
 * (dangerouslyAllowBrowser: 키가 브라우저에 있다는 뜻. 외부 스크립트 차단(CSP)으로 보호한다)
 */
export function createAnthropicGenerator(opts: AnthropicOptions): Generator {
  if (!opts.apiKey) throw new GenerationError("Anthropic API 키가 없습니다. 설정에서 입력하세요");
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });

  return async (req) => {
    let msg;
    try {
      // max_tokens가 커서 스트리밍으로 받는다. 이벤트는 쓰지 않고 최종 메시지만 쓴다.
      msg = await client.beta.messages
        .stream({
          model: opts.model,
          max_tokens: opts.maxTokens,
          thinking: { type: "adaptive" },
          output_config: { effort: opts.effort, format: zodOutputFormat(req.schema) },
          // 안전 분류기가 거절하면 서버가 다른 모델로 이어서 처리한다
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        })
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new GenerationError("API 키가 올바르지 않습니다 (설정에서 확인)");
      if (e instanceof Anthropic.PermissionDeniedError) throw new GenerationError("이 API 키로는 이 모델을 쓸 수 없습니다");
      if (e instanceof Anthropic.RateLimitError) throw new GenerationError("API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요");
      if (e instanceof Anthropic.APIConnectionError) throw new GenerationError("Anthropic API에 연결하지 못했습니다 (네트워크 확인)");
      if (e instanceof Anthropic.APIError) throw new GenerationError(`API 오류 (${e.status ?? "?"}): ${e.message}`);
      throw e;
    }
    if (msg.stop_reason === "refusal") throw new GenerationError("모델이 요청을 거절했습니다");
    if (msg.stop_reason === "max_tokens") throw new GenerationError("출력이 max_tokens에서 잘렸습니다 (설정의 최대 토큰 확인)");
    if (msg.parsed_output == null) throw new GenerationError("모델 출력을 스키마로 읽지 못했습니다");
    return {
      data: msg.parsed_output as z.infer<typeof req.schema>,
      model: msg.model,
      stopReason: msg.stop_reason,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    };
  };
}

/** 설정 화면의 "연결 확인": 키가 유효한지 보고, 쓸 수 있는 모델 목록을 가져온다 */
export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  try {
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new GenerationError("API 키가 올바르지 않습니다");
    if (e instanceof Anthropic.APIConnectionError) throw new GenerationError("Anthropic API에 연결하지 못했습니다 (네트워크 확인)");
    if (e instanceof Anthropic.APIError) throw new GenerationError(`API 오류 (${e.status ?? "?"}): ${e.message}`);
    throw e;
  }
}
