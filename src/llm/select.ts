import { currentModel, type LlmProvider, type Secrets, type Settings } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";
import { createBridgeGenerator } from "./bridgeGenerator";
import { devFakeGenerator } from "./fake";

/** 첫 호출 때 SDK를 불러온다 (쓰지 않는 회사의 SDK는 내려받지 않게) */
function lazy(load: () => Promise<Generator>): Generator {
  let ready: Promise<Generator> | null = null;
  return ((req) => (ready ??= load()).then((g) => g(req))) as Generator;
}

/** 설정에 맞는 생성기. 비밀값은 호출할 때만 넘기고 어디에도 기록하지 않는다 */
export function createGenerator(settings: Settings, secrets: Secrets): Generator {
  const l = settings.llm;
  const model = currentModel(settings);
  if (l.provider !== "fake" && !model) throw new GenerationError("설정에서 모델을 고르세요");
  const common = { model, effort: l.effort, maxTokens: l.maxTokens };
  switch (l.provider) {
    case "anthropic":
      return lazy(async () => (await import("./anthropicGenerator")).createAnthropicGenerator({ apiKey: secrets.anthropicApiKey ?? "", ...common }));
    case "openai":
      return lazy(async () => (await import("./openaiGenerator")).createOpenAIGenerator({ apiKey: secrets.openaiApiKey ?? "", ...common }));
    case "gemini":
      return lazy(async () => (await import("./geminiGenerator")).createGeminiGenerator({ apiKey: secrets.geminiApiKey ?? "", ...common }));
    case "bridge":
      return createBridgeGenerator({ url: l.bridgeUrl, token: secrets.bridgeToken ?? "", model, effort: l.effort });
    case "fake":
      return devFakeGenerator();
  }
}

export const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: "Anthropic (Claude) API 키",
  openai: "OpenAI API 키",
  gemini: "Google Gemini API 키",
  bridge: "Claude CLI 브리지",
  fake: "가짜 모델 (화면 시험용)",
};

/** 연결 방식별 비밀값 이름 */
export const SECRET_FOR: Partial<Record<LlmProvider, keyof Secrets>> = {
  anthropic: "anthropicApiKey",
  openai: "openaiApiKey",
  gemini: "geminiApiKey",
  bridge: "bridgeToken",
};

/**
 * 연결 확인. 성공하면 안내 문구와 (가능하면) 쓸 수 있는 모델 목록을 돌려준다.
 * 모델 이름은 우리가 정하지 않고 각 회사 API가 알려 주는 목록에서 고르게 한다.
 */
export async function checkConnection(settings: Settings, secret: string): Promise<{ message: string; models: string[] }> {
  const l = settings.llm;
  if (!secret && l.provider !== "fake") throw new GenerationError("키(또는 연결 코드)를 입력하세요");
  switch (l.provider) {
    case "anthropic": {
      const m = await import("./anthropicGenerator");
      const models = await m.listAnthropicModels(secret);
      return { message: `연결됨 (모델 ${models.length}개)`, models };
    }
    case "openai": {
      const models = await (await import("./openaiGenerator")).checkOpenAI(secret);
      return { message: `연결됨 (모델 ${models.length}개)`, models };
    }
    case "gemini": {
      const models = await (await import("./geminiGenerator")).checkGemini(secret);
      return { message: `연결됨 (모델 ${models.length}개)`, models };
    }
    case "bridge": {
      const { checkBridge } = await import("./bridgeGenerator");
      return { message: await checkBridge(l.bridgeUrl, secret), models: [] };
    }
    case "fake":
      return { message: "가짜 모델은 연결이 필요 없습니다", models: [] };
  }
}
