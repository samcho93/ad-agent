import OpenAI from "openai";
import type { Effort } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";
import { parseJsonOutput, toStrictJsonSchema } from "./jsonSchema";

export interface OpenAIOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  maxTokens: number;
}

/** 추론 모델이 아니면 reasoning 설정을 보내지 않는다 (gpt-4o 등은 거부함) */
const isReasoningModel = (model: string) => /^(o\d|gpt-5)/.test(model);

function wrap(e: unknown): never {
  if (e instanceof OpenAI.AuthenticationError) throw new GenerationError("OpenAI API 키가 올바르지 않습니다 (설정에서 확인)");
  if (e instanceof OpenAI.PermissionDeniedError) throw new GenerationError("이 OpenAI 키로는 이 모델을 쓸 수 없습니다");
  if (e instanceof OpenAI.NotFoundError) throw new GenerationError("OpenAI 모델을 찾을 수 없습니다 (설정의 모델 이름 확인)");
  if (e instanceof OpenAI.RateLimitError) throw new GenerationError("OpenAI 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요");
  if (e instanceof OpenAI.APIConnectionError) throw new GenerationError("OpenAI API에 연결하지 못했습니다 (네트워크 확인)");
  if (e instanceof OpenAI.APIError) throw new GenerationError(`OpenAI 오류 (${e.status ?? "?"}): ${e.message}`);
  throw e;
}

/**
 * 사용자 본인의 OpenAI API 키로 브라우저에서 직접 호출한다 (Responses API, 구조화된 출력 strict).
 * 키는 사용자 브라우저에만 있다.
 */
export function createOpenAIGenerator(opts: OpenAIOptions): Generator {
  if (!opts.apiKey) throw new GenerationError("OpenAI API 키가 없습니다. 설정에서 입력하세요");
  const client = new OpenAI({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });

  return async (req) => {
    let res;
    try {
      res = await client.responses.create({
        model: opts.model,
        instructions: req.system,
        input: req.user,
        max_output_tokens: opts.maxTokens,
        ...(isReasoningModel(opts.model) ? { reasoning: { effort: opts.effort } } : {}),
        text: { format: { type: "json_schema", name: req.purpose, schema: toStrictJsonSchema(req.schema), strict: true } },
      });
    } catch (e) {
      wrap(e);
    }
    const refusal = res.output.flatMap((o) => (o.type === "message" ? o.content : [])).find((c) => c.type === "refusal");
    if (refusal) throw new GenerationError("모델이 요청을 거절했습니다");
    if (res.status === "incomplete") {
      throw new GenerationError(`출력이 끝나지 않았습니다 (${res.incomplete_details?.reason ?? "원인 미상"}). 설정의 최대 토큰을 늘려 보세요`);
    }
    let data;
    try {
      data = parseJsonOutput(req.schema, res.output_text);
    } catch (e) {
      throw new GenerationError((e as Error).message);
    }
    return {
      data,
      model: res.model,
      stopReason: res.status ?? null,
      usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
    };
  };
}

/** 연결 확인 + 쓸 수 있는 모델 목록 */
export async function checkOpenAI(apiKey: string): Promise<string[]> {
  const client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true });
  try {
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort();
  } catch (e) {
    wrap(e);
  }
}
