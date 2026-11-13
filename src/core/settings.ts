import defaults from "../../config/settings.json";
import type { ProductRule } from "./productRules";

/**
 * LLM 연결 방식.
 * - API 키: "anthropic" | "openai" | "gemini" (사용자 본인 키, 브라우저에서 직접 호출)
 * - "bridge": Claude Code 사용자의 로컬 CLI 브리지
 * - "fake": 개발용 가짜 모델
 */
export type LlmProvider = "anthropic" | "openai" | "gemini" | "bridge" | "fake";
export type ModelProvider = Exclude<LlmProvider, "fake">;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  llm: {
    provider: LlmProvider;
    /** 연결 방식마다 따로 기억하는 모델 이름. 비어 있으면 설정에서 골라야 한다 */
    models: Record<ModelProvider, string>;
    effort: Effort;
    maxTokens: number;
    /** Claude CLI 브리지 주소 (이 PC에서 실행, 127.0.0.1 전용) */
    bridgeUrl: string;
  };
  revision: { includedCount: string | number; includedCountRange: string };
  /** 매체별 파일 용량 한도(KB). 근거가 없어 기본은 "확인 필요" (숫자를 넣으면 검수에서 비교) */
  qa: { maxFileKB: string | number };
  /** 제품 종류별 규칙 (색·구도·문구 길이). 사람이 넣는다. 기본은 비어 있음 */
  productRules: ProductRule[];
  pricing: string;
  privacyRetention: string;
  imageModel: string;
  defaultVariants: number;
  composeBackend: string;
}

/** 비밀값. 사용자 브라우저에만 저장되고 서버로 보내지 않는다 (절대 규칙 6) */
export interface Secrets {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  bridgeToken?: string;
  figmaToken?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  llm: { ...(defaults.llm as Settings["llm"]), models: { ...(defaults.llm.models as Settings["llm"]["models"]) } },
  revision: defaults.revision,
  qa: defaults.qa,
  productRules: [],
  pricing: defaults.pricing,
  privacyRetention: defaults.privacyRetention,
  imageModel: defaults.imageModel,
  defaultVariants: defaults.defaultVariants,
  composeBackend: defaults.composeBackend,
};

/** 저장된 설정을 기본값 위에 덮는다 (필드가 늘어나도 깨지지 않게) */
export function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  if (!saved) return structuredClone(DEFAULT_SETTINGS);
  // 예전 형식(llm.model 하나)을 연결 방식별 models 로 옮긴다
  const legacy = saved.llm as (Partial<Settings["llm"]> & { model?: string }) | undefined;
  const models = { ...DEFAULT_SETTINGS.llm.models, ...(legacy?.models ?? {}) };
  if (legacy?.model && !legacy.models) {
    if (legacy.provider === "anthropic" || legacy.provider === "bridge") models[legacy.provider] = legacy.model;
  }
  const { model: _drop, ...llmRest } = legacy ?? {};
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    llm: { ...DEFAULT_SETTINGS.llm, ...llmRest, models },
    revision: { ...DEFAULT_SETTINGS.revision, ...(saved.revision ?? {}) },
    qa: { ...DEFAULT_SETTINGS.qa, ...(saved.qa ?? {}) },
    productRules: Array.isArray(saved.productRules) ? saved.productRules : [],
  };
}

/** 지금 연결 방식의 모델 이름 */
export function currentModel(s: Settings): string {
  return s.llm.provider === "fake" ? "fake-model" : s.llm.models[s.llm.provider] ?? "";
}

/** 화면 표시용: 끝 4자리만 */
export function maskSecret(v: string | undefined): string {
  if (!v) return "없음";
  return v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;
}
