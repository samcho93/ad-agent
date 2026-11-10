import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { Effort } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";
import { parseJsonOutput, toStrictJsonSchema } from "./jsonSchema";

export interface GeminiOptions {
  apiKey: string;
  model: string;
  effort: Effort;
  maxTokens: number;
}

/** Gemini 3 계열만 thinkingLevel 을 받는다. 그 밖의 모델은 기본 설정으로 둔다 */
function thinkingFor(model: string, effort: Effort) {
  if (!/^gemini-3/.test(model)) return undefined;
  const level = effort === "low" ? ThinkingLevel.LOW : effort === "medium" ? ThinkingLevel.MEDIUM : ThinkingLevel.HIGH;
  return { thinkingLevel: level };
}

function wrap(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number }).status;
  if (status === 400 && /API key/i.test(msg)) throw new GenerationError("Gemini API 키가 올바르지 않습니다 (설정에서 확인)");
  if (status === 401 || status === 403) throw new GenerationError("Gemini API 키가 올바르지 않거나 권한이 없습니다");
  if (status === 404) throw new GenerationError("Gemini 모델을 찾을 수 없습니다 (설정의 모델 이름 확인)");
  if (status === 429) throw new GenerationError("Gemini 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요");
  if (/fetch|network/i.test(msg)) throw new GenerationError("Gemini API에 연결하지 못했습니다 (네트워크 확인)");
  throw new GenerationError(`Gemini 오류${status ? ` (${status})` : ""}: ${msg.slice(0, 300)}`);
}

/**
 * 사용자 본인의 Gemini API 키(Google AI Studio)로 브라우저에서 직접 호출한다.
 * JSON 스키마로 출력 형식을 지정하고, 결과는 코드에서 다시 검증한다.
 */
export function createGeminiGenerator(opts: GeminiOptions): Generator {
  if (!opts.apiKey) throw new GenerationError("Gemini API 키가 없습니다. 설정에서 입력하세요");
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });

  return async (req) => {
    let res;
    try {
      const thinking = thinkingFor(opts.model, opts.effort);
      res = await ai.models.generateContent({
        model: opts.model,
        contents: req.user,
        config: {
          systemInstruction: req.system,
          responseMimeType: "application/json",
          responseJsonSchema: toStrictJsonSchema(req.schema),
          maxOutputTokens: opts.maxTokens,
          ...(thinking ? { thinkingConfig: thinking } : {}),
        },
      });
    } catch (e) {
      wrap(e);
    }
    if (res.promptFeedback?.blockReason) throw new GenerationError(`모델이 요청을 거절했습니다 (${res.promptFeedback.blockReason})`);
    const finish = res.candidates?.[0]?.finishReason;
    if (finish === "MAX_TOKENS") throw new GenerationError("출력이 최대 토큰에서 잘렸습니다. 설정의 최대 토큰을 늘려 보세요");
    if (finish && finish !== "STOP") throw new GenerationError(`모델이 생성을 멈췄습니다 (${finish})`);
    let data;
    try {
      data = parseJsonOutput(req.schema, res.text ?? "");
    } catch (e) {
      throw new GenerationError((e as Error).message);
    }
    return {
      data,
      model: res.modelVersion ?? opts.model,
      stopReason: finish ?? null,
      usage: { input_tokens: res.usageMetadata?.promptTokenCount ?? 0, output_tokens: res.usageMetadata?.candidatesTokenCount ?? 0 },
    };
  };
}

/** 연결 확인 + 생성에 쓸 수 있는 모델 목록 */
export async function checkGemini(apiKey: string): Promise<string[]> {
  const ai = new GoogleGenAI({ apiKey });
  try {
    const ids: string[] = [];
    const pager = await ai.models.list();
    for await (const m of pager) {
      if (m.name && (m.supportedActions ?? ["generateContent"]).includes("generateContent")) ids.push(m.name.replace(/^models\//, ""));
    }
    return ids.filter((id) => id.startsWith("gemini")).sort();
  } catch (e) {
    wrap(e);
  }
}
