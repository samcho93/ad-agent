import { z } from "zod/v4";
import type { ComposeDoc, CopySpace, Corner, Variant, VariantCopy } from "./compose";
import type { RevisionRecord } from "./delivery";
import { factIssues, type Issue } from "./validate";

/**
 * 광고주 수정 요청 → AI 수정안 (초안). 사람이 골라서 적용한다. 자동으로 바꾸지 않는다.
 * - 문구: 요청에 맞춘 헤드라인·리드·서브·버튼 문구 후보
 * - 배치·색: 바꿀 값 제안 (허용 범위를 코드가 다시 검사)
 */

export const LAYOUT_FIELDS = ["copySpace", "textColor", "overlay", "productScale", "productDx", "productDy", "logoCorner", "logoScale", "buttonBg", "buttonFg", "subColor"] as const;
export type LayoutField = (typeof LAYOUT_FIELDS)[number];

export const LAYOUT_FIELD_LABEL: Record<LayoutField, string> = {
  copySpace: "문구 위치",
  textColor: "글자 색",
  overlay: "그라데이션 세기",
  productScale: "제품 크기",
  productDx: "제품 좌우 위치",
  productDy: "제품 위아래 위치",
  logoCorner: "로고 위치",
  logoScale: "로고 크기",
  buttonBg: "버튼 색",
  buttonFg: "버튼 글자 색",
  subColor: "서브카피 색",
};

export const RevisionModelOutput = z.object({
  copyOptions: z
    .array(
      z.object({
        variant: z.enum(["A", "B"]).describe("이 문구안을 넣을 시안"),
        lead: z.string().describe("헤드라인 위 작은 줄. 바꾸지 않으면 지금 값 그대로, 없애려면 빈 문자열"),
        headline: z.string().describe("헤드라인. 뜻 단위로 끊을 곳은 \\n"),
        sub: z.string(),
        cta: z.string(),
        reason: z.string().describe("요청의 어느 부분을 어떻게 반영했는지 한 문장"),
      }),
    )
    .describe("글자 수정 요청이 있을 때만 0~3개. 없으면 빈 배열"),
  layoutSuggestions: z
    .array(
      z.object({
        field: z.enum(LAYOUT_FIELDS),
        variant: z.enum(["A", "B", "공통"]).describe("버튼·서브카피 색은 A 또는 B, 나머지는 공통"),
        value: z.string().describe("바꿀 값. 문구 위치: 위/아래/왼쪽/오른쪽, 글자 색: #ffffff 또는 #1f1d1a, 숫자는 숫자만, 색은 #rrggbb, 로고 위치: tl/tr/bl/br"),
        reason: z.string(),
      }),
    )
    .describe("색·위치·크기 요청이 있을 때 0~6개"),
  needsHuman: z.string().describe("AI가 바꿀 수 없어 사람이 해야 하는 일 (예: 이미지 교체). 없으면 빈 문자열"),
});
export type RevisionModelOutput = z.infer<typeof RevisionModelOutput>;

export interface CopyOption {
  variant: Variant;
  patch: Pick<VariantCopy, "lead" | "headline" | "sub" | "cta">;
  reason: string;
  issues: Issue[];
}

export interface LayoutSuggestion {
  field: LayoutField;
  variant: Variant | "공통";
  value: string | number;
  reason: string;
}

export interface RevisionDraft {
  revisionAt: string;
  model: string;
  createdAt: string;
  copyOptions: CopyOption[];
  layout: LayoutSuggestion[];
  /** 범위를 벗어나 버린 제안 */
  dropped: string[];
  needsHuman: string;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const RANGE: Partial<Record<LayoutField, [number, number]>> = {
  overlay: [0, 0.9],
  productScale: [0.3, 1.6],
  productDx: [-0.5, 0.5],
  productDy: [-0.5, 0.5],
  logoScale: [0.5, 2],
};
const PER_VARIANT: LayoutField[] = ["buttonBg", "buttonFg", "subColor"];

/** 모델 제안 하나를 허용 범위로 검사한다. 맞지 않으면 null */
export function parseSuggestion(s: RevisionModelOutput["layoutSuggestions"][number], doc: ComposeDoc): LayoutSuggestion | null {
  const v = s.value.trim();
  const perVariant = PER_VARIANT.includes(s.field);
  if (perVariant && s.variant === "공통") return null;
  const variant = perVariant ? (s.variant as Variant) : "공통";
  const r = RANGE[s.field];
  if (r) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < r[0] || n > r[1]) return null;
    if ((s.field.startsWith("product") && !doc.shared.product) || (s.field === "logoScale" && !doc.shared.logo)) return null;
    return { field: s.field, variant, value: Math.round(n * 100) / 100, reason: s.reason.trim() };
  }
  if (s.field === "copySpace") return ["위", "아래", "왼쪽", "오른쪽"].includes(v) ? { field: s.field, variant, value: v, reason: s.reason.trim() } : null;
  if (s.field === "textColor") return v === "#ffffff" || v === "#1f1d1a" ? { field: s.field, variant, value: v, reason: s.reason.trim() } : null;
  if (s.field === "logoCorner") return doc.shared.logo && ["tl", "tr", "bl", "br"].includes(v) ? { field: s.field, variant, value: v, reason: s.reason.trim() } : null;
  return HEX.test(v) ? { field: s.field, variant, value: v.toLowerCase(), reason: s.reason.trim() } : null;
}

/** 모델 출력 → 화면에 보일 수정안. 문구는 브리프와 같은 사실·금지어 검사를 한다 */
export function buildRevisionDraft(out: RevisionModelOutput, doc: ComposeDoc, rev: RevisionRecord, corpus: string, banned: string[], model: string): RevisionDraft {
  const copyOptions: CopyOption[] = out.copyOptions.slice(0, 3).map((o) => {
    const patch = { lead: o.lead.trim(), headline: o.headline.replace(/\\n/g, "\n").trim(), sub: o.sub.trim(), cta: o.cta.trim() };
    const issues = factIssues(`수정안 ${o.variant}`, [patch.lead, patch.headline, patch.sub, patch.cta].join("\n"), corpus, banned);
    if (!patch.headline) issues.push({ severity: "error", where: `수정안 ${o.variant}`, message: "헤드라인이 비어 있습니다" });
    if (!patch.cta) issues.push({ severity: "error", where: `수정안 ${o.variant}`, message: "버튼 문구가 비어 있습니다" });
    return { variant: o.variant, patch, reason: o.reason.trim(), issues };
  });
  const layout: LayoutSuggestion[] = [];
  const dropped: string[] = [];
  for (const s of out.layoutSuggestions.slice(0, 6)) {
    const p = parseSuggestion(s, doc);
    if (p) layout.push(p);
    else dropped.push(`${LAYOUT_FIELD_LABEL[s.field]} ${s.value} (허용 범위 밖이거나 이 시안에 없는 항목)`);
  }
  return { revisionAt: rev.at, model, createdAt: new Date().toISOString(), copyOptions, layout, dropped, needsHuman: out.needsHuman.trim() };
}

/** 제안 하나를 합성 명세에 적용한 새 명세 (원본은 바꾸지 않음) */
export function applySuggestion(doc: ComposeDoc, s: LayoutSuggestion): ComposeDoc {
  const d = structuredClone(doc);
  const n = Number(s.value);
  switch (s.field) {
    case "copySpace": d.shared.copySpace = s.value as CopySpace; break;
    case "textColor": d.shared.textColor = s.value as ComposeDoc["shared"]["textColor"]; break;
    case "overlay": d.shared.overlay = n; break;
    case "productScale": if (d.shared.product) d.shared.product.scale = n; break;
    case "productDx": if (d.shared.product) d.shared.product.dx = n; break;
    case "productDy": if (d.shared.product) d.shared.product.dy = n; break;
    case "logoCorner": if (d.shared.logo) d.shared.logo.corner = s.value as Corner; break;
    case "logoScale": if (d.shared.logo) d.shared.logo.scale = n; break;
    case "buttonBg": d.variants[s.variant as Variant].buttonBg = String(s.value); break;
    case "buttonFg": d.variants[s.variant as Variant].buttonFg = String(s.value); break;
    case "subColor": d.variants[s.variant as Variant].subColor = String(s.value); break;
  }
  return d;
}

/** 화면 표시용: 지금 값 */
export function currentValue(doc: ComposeDoc, field: LayoutField, variant: Variant | "공통"): string {
  const sh = doc.shared;
  switch (field) {
    case "copySpace": return sh.copySpace;
    case "textColor": return sh.textColor;
    case "overlay": return String(sh.overlay);
    case "productScale": return String(sh.product?.scale ?? "-");
    case "productDx": return String(sh.product?.dx ?? "-");
    case "productDy": return String(sh.product?.dy ?? "-");
    case "logoCorner": return sh.logo?.corner ?? "-";
    case "logoScale": return String(sh.logo?.scale ?? "-");
    default: {
      if (variant === "공통") return "-";
      const c = doc.variants[variant];
      return field === "buttonBg" ? c.buttonBg : field === "buttonFg" ? c.buttonFg : c.subColor ?? "(글자 색)";
    }
  }
}
