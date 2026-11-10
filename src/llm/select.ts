import type { Secrets, Settings } from "@/core/settings";
import type { Generator } from "./generator";
import { createAnthropicGenerator } from "./anthropicGenerator";
import { createBridgeGenerator } from "./bridgeGenerator";
import { devFakeGenerator } from "./fake";

/** 설정에 맞는 생성기. 비밀값은 호출할 때만 넘기고 어디에도 기록하지 않는다 */
export function createGenerator(settings: Settings, secrets: Secrets): Generator {
  const l = settings.llm;
  switch (l.provider) {
    case "anthropic":
      return createAnthropicGenerator({ apiKey: secrets.anthropicApiKey ?? "", model: l.model, effort: l.effort, maxTokens: l.maxTokens });
    case "bridge":
      return createBridgeGenerator({ url: l.bridgeUrl, token: secrets.bridgeToken ?? "", model: l.model, effort: l.effort });
    case "fake":
      return devFakeGenerator();
  }
}

export const PROVIDER_LABEL: Record<Settings["llm"]["provider"], string> = {
  anthropic: "Anthropic API 키",
  bridge: "Claude CLI 브리지",
  fake: "가짜 모델 (화면 시험용)",
};
