import defaults from "../../config/settings.json";

/** LLM 연결 방식. 일반 사용자는 "anthropic"(본인 API 키), Claude CLI 사용자는 "bridge"(로컬 브리지) */
export type LlmProvider = "anthropic" | "bridge" | "fake";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  llm: {
    provider: LlmProvider;
    model: string;
    effort: Effort;
    maxTokens: number;
    /** Claude CLI 브리지 주소 (이 PC에서 실행, 127.0.0.1 전용) */
    bridgeUrl: string;
  };
  revision: { includedCount: string | number; includedCountRange: string };
  pricing: string;
  privacyRetention: string;
  imageModel: string;
  defaultVariants: number;
  composeBackend: string;
}

/** 비밀값. 사용자 브라우저에만 저장되고 서버로 보내지 않는다 (절대 규칙 6) */
export interface Secrets {
  anthropicApiKey?: string;
  bridgeToken?: string;
  figmaToken?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  llm: { ...(defaults.llm as Settings["llm"]) },
  revision: defaults.revision,
  pricing: defaults.pricing,
  privacyRetention: defaults.privacyRetention,
  imageModel: defaults.imageModel,
  defaultVariants: defaults.defaultVariants,
  composeBackend: defaults.composeBackend,
};

/** 저장된 설정을 기본값 위에 덮는다 (필드가 늘어나도 깨지지 않게) */
export function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  if (!saved) return structuredClone(DEFAULT_SETTINGS);
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...(saved.llm ?? {}) },
    revision: { ...DEFAULT_SETTINGS.revision, ...(saved.revision ?? {}) },
  };
}

/** 화면 표시용: 끝 4자리만 */
export function maskSecret(v: string | undefined): string {
  if (!v) return "없음";
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}
