import { z } from "zod/v4";
import type { Intake } from "./intake";

/**
 * 제품 종류별 규칙: 사람이 광고 경험으로 정한 색·구도·문구 길이 (예: 착즙기 → 신선함, 초록).
 * 앱은 내용을 지어내지 않는다. 사용자가 설정에서 넣은 규칙만 쓴다.
 */
export const ProductRuleSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  /** 1부 1번(무엇을 파시나요) 답에 이 낱말이 있으면 이 규칙을 쓴다 */
  keywords: z.array(z.string().trim().min(1).max(30)).min(1).max(20),
  /** 강조색 (버튼 색 기본값). 없으면 앱 기본값 */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  /** 색·톤을 고른 이유 (화면에 보여 줌) */
  colorReason: z.string().max(200).default(""),
  /** 구도·배치 메모 (이미지 프롬프트·아이디어에 참고로 넣음) */
  composition: z.string().max(500).default(""),
  /** 헤드라인 최대 글자 수 (띄어쓰기·줄바꿈 제외). 없으면 점검 안 함 */
  maxHeadline: z.number().int().min(4).max(60).nullable().default(null),
  note: z.string().max(500).default(""),
});
export type ProductRule = z.infer<typeof ProductRuleSchema>;

export const ProductRulesFileSchema = z.object({
  format: z.literal("ad-agent-product-rules"),
  version: z.literal(1),
  rules: z.array(ProductRuleSchema).max(100),
});

/** 1부 1번 답에 키워드가 처음 들어맞는 규칙 */
export function matchRule(rules: ProductRule[] | undefined, intake: Intake): ProductRule | null {
  const text = intake.answers["1"].text.toLowerCase();
  return (rules ?? []).find((r) => r.keywords.some((k) => k.trim() && text.includes(k.trim().toLowerCase()))) ?? null;
}

/** 프롬프트에 넣을 참고 문단 */
export function ruleForPrompt(rule: ProductRule | null): string {
  if (!rule) return "";
  return [
    `<제품_종류_규칙 이름="${rule.name}"> (사람이 정한 규칙. 참고해서 따른다)`,
    rule.accent ? `- 강조색: ${rule.accent}${rule.colorReason ? ` (${rule.colorReason})` : ""}` : "",
    rule.composition ? `- 구도·배치: ${rule.composition}` : "",
    rule.maxHeadline ? `- 헤드라인은 ${rule.maxHeadline}자 이내 (띄어쓰기 제외)` : "",
    rule.note ? `- 메모: ${rule.note}` : "",
    "</제품_종류_규칙>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** 띄어쓰기·줄바꿈을 뺀 글자 수 */
export const headlineLength = (t: string) => [...t.replace(/\s+/g, "")].length;
