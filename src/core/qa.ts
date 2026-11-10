import { z } from "zod/v4";
import { type ComposeDoc, type SizeKey, type Variant, sizeOf } from "./compose";
import type { Issue } from "./validate";

/**
 * MVP 4단계: 검수 (ad-qa).
 * 1) 규칙 검사: 코드로 확인할 수 있는 것 (규격, 용량, 문구 점검, 로고, A/B 차이)
 * 2) 이미지 검수: LLM이 결과 PNG만 보고 판단 (AI 글자·로고, 가독성, 제품 일치, 심의 위험)
 * 최종 판단은 게이트 2에서 사람이 한다.
 */

export type QaSeverity = "error" | "warning" | "info";

export interface QaCheck {
  id: string;
  source: "rule" | "llm";
  severity: QaSeverity;
  where: string;
  message: string;
}

export interface QaOverride {
  reason: string;
  by: string;
  at: string;
}

export type LlmQaStatus = "done" | "unsupported" | "failed" | "skipped";

export interface QaDoc {
  version: 1;
  ranAt: string;
  ranBy: string;
  /** 검수한 합성 명세의 수정 시각. 합성이 바뀌면 검수를 다시 해야 한다 */
  composeUpdatedAt: string;
  /** 심의 업종 (대상·확인 필요) */
  review: boolean;
  checks: QaCheck[];
  llm: { status: LlmQaStatus; model?: string; note: string; overall?: string; files: string[] };
  /** 자동 검수 오류를 사유를 적고 넘긴 기록 (check id → 사유) */
  overrides: Record<string, QaOverride>;
  /** 게이트 2 사람 확인 항목 (항목 → 확인한 사람) */
  human: Record<string, { by: string; at: string }>;
}

/* ------------------------------------------------------------------ */
/* 1. 규칙 검사                                                          */
/* ------------------------------------------------------------------ */

/** PNG 헤더에서 가로·세로를 읽는다 (IHDR). PNG가 아니면 null */
export function pngSize(bytes: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

/** 같은 내용이면 같은 id (다시 검수해도 넘김 사유가 유지되게) */
export function checkId(prefix: string, text: string): string {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return `${prefix}:${h.toString(36)}`;
}

export interface RenderInfo {
  variant: Variant;
  size: SizeKey;
  file: string;
  /** 파일이 없으면 null */
  bytes: Uint8Array | null;
}

export interface RuleInput {
  doc: ComposeDoc;
  renders: RenderInfo[];
  copyIssues: Issue[];
  hasLogoAsset: boolean;
  specs: Record<Variant, Record<string, unknown> | null>;
  maxFileKB: string | number;
}

const kb = (n: number) => Math.round((n / 1024) * 10) / 10;

export function ruleChecks(input: RuleInput): QaCheck[] {
  const out: QaCheck[] = [];
  const add = (severity: QaSeverity, where: string, message: string) => out.push({ id: checkId("rule", `${where}|${message}`), source: "rule", severity, where, message });

  // 규격과 용량
  const limit = typeof input.maxFileKB === "number" ? input.maxFileKB : Number.NaN;
  for (const v of ["A", "B"] as const) {
    for (const size of input.doc.shared.sizes) {
      const r = input.renders.find((x) => x.variant === v && x.size === size);
      const where = `시안 ${v} ${size}`;
      if (!r?.bytes) {
        add("error", where, "시안 이미지 파일이 없습니다. 합성에서 PNG를 다시 저장하세요");
        continue;
      }
      const dim = pngSize(r.bytes);
      const want = sizeOf(size);
      if (!dim) add("error", where, "PNG 파일이 아닙니다");
      else if (dim.w !== want.w || dim.h !== want.h) add("error", where, `크기가 규격과 다릅니다 (${dim.w}x${dim.h}, 규격 ${size})`);
      const k = kb(r.bytes.length);
      if (Number.isFinite(limit) && k > limit) add("warning", where, `파일 용량 ${k}KB가 설정한 한도 ${limit}KB를 넘습니다`);
      else add("info", where, `규격 ${size} 확인, 용량 ${k}KB`);
    }
  }
  if (!Number.isFinite(limit)) add("info", "용량 한도", `매체별 파일 용량 한도: ${String(input.maxFileKB)} (설정에서 정하면 비교합니다)`);

  // 문구 점검 (합성 명세로 다시 확인: 금지어, 근거 없는 숫자, 빈 문구, 버튼 대비)
  for (const i of input.copyIssues) add(i.severity === "error" ? "error" : "warning", i.where, i.message);

  // 로고
  if (input.hasLogoAsset && !input.doc.shared.logo) add("warning", "로고", "광고주 로고 파일이 있는데 시안에 로고가 없습니다");
  if (input.doc.shared.logo && input.doc.shared.sizes.includes("320x100")) add("info", "로고", "320x100 띠 배너에는 공간이 작아 로고를 넣지 않습니다");

  // A/B: 그림·배치는 같고 문구·버튼만 달라야 한다
  const { A, B } = input.specs;
  if (!A || !B) add("error", "시안 A/B", "합성 명세 파일(compose_spec_A/B.json)이 없습니다");
  else {
    const strip = (s: Record<string, unknown>) => {
      const { variant: _v, texts: _t, button: _b, ...rest } = s;
      return JSON.stringify(rest);
    };
    if (strip(A) !== strip(B)) add("error", "시안 A/B", "A와 B의 그림·배치가 다릅니다. 시안 A/B는 문구·버튼만 달라야 합니다");
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. 이미지 검수 (LLM)                                                  */
/* ------------------------------------------------------------------ */

export const QaModelOutput = z.object({
  images: z.array(
    z.object({
      file: z.string(),
      generatedTextOrLogo: z.object({ found: z.boolean(), evidence: z.string() }),
      copyReadable: z.object({ ok: z.boolean(), evidence: z.string() }),
      productMatch: z.object({ status: z.enum(["같음", "다름", "판단 어려움", "해당 없음"]), evidence: z.string() }),
      reviewRisk: z.object({ found: z.boolean(), evidence: z.string() }),
    }),
  ),
  overall: z.string(),
});
export type QaModelOutput = z.infer<typeof QaModelOutput>;

/** 모델 판정 → 검수 항목. 판정은 코드가 심각도로 바꾼다 (모델이 "통과"를 정하지 않게) */
export function llmChecks(out: QaModelOutput, sentFiles: string[], opts: { review: boolean; hasOriginal: boolean }): QaCheck[] {
  const res: QaCheck[] = [];
  const add = (severity: QaSeverity, where: string, message: string) => res.push({ id: checkId("llm", `${where}|${message}`), source: "llm", severity, where, message });
  for (const file of sentFiles) {
    const r = out.images.find((x) => x.file.trim() === file);
    if (!r) {
      add("warning", file, "이미지 검수 결과가 없습니다. 사람이 직접 확인하세요");
      continue;
    }
    if (r.generatedTextOrLogo.found) add("error", file, `AI가 만든 글자·로고로 보이는 부분: ${r.generatedTextOrLogo.evidence || "(근거 없음)"}`);
    if (!r.copyReadable.ok) add("warning", file, `문구 가독성: ${r.copyReadable.evidence || "(근거 없음)"}`);
    if (opts.hasOriginal) {
      if (r.productMatch.status === "다름") add("error", file, `제품이 원본과 다르게 보입니다: ${r.productMatch.evidence || "(근거 없음)"}`);
      else if (r.productMatch.status === "판단 어려움") add("warning", file, `제품이 원본과 같은지 판단이 어렵습니다. 나란히 비교하세요: ${r.productMatch.evidence}`);
    }
    if (r.reviewRisk.found) add(opts.review ? "error" : "warning", file, `${opts.review ? "심의 위험" : "과장 우려"}: ${r.reviewRisk.evidence || "(근거 없음)"}`);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* 3. 게이트 2                                                           */
/* ------------------------------------------------------------------ */

export const BASE_HUMAN_CHECKS = ["오탈자 없음", "로고 위치·크기 확인", "광고주 확인 요청 사항 처리", "브랜드 톤·색 확인"] as const;
export const REVIEW_HUMAN_CHECK = "카피 사전 점검 완료 (심의 위험 표현 확인)";
export const MANUAL_IMAGE_CHECK = "이미지 안에 AI가 만든 글자·로고·워터마크 없음 (자동 이미지 검수를 못 해 사람이 확인)";

export function humanChecklist(qa: Pick<QaDoc, "review" | "llm">): string[] {
  const items: string[] = [...BASE_HUMAN_CHECKS];
  if (qa.review) items.push(REVIEW_HUMAN_CHECK);
  if (qa.llm.status !== "done") items.push(MANUAL_IMAGE_CHECK);
  return items;
}

/** 넘기지 않은 오류 */
export const openErrors = (qa: QaDoc) => qa.checks.filter((c) => c.severity === "error" && !qa.overrides[c.id]);

export interface Gate2Readiness {
  ok: boolean;
  blockers: string[];
}

export function gate2Readiness(qa: QaDoc | null, fresh: boolean): Gate2Readiness {
  const blockers: string[] = [];
  if (!qa) return { ok: false, blockers: ["검수를 실행하세요"] };
  if (!fresh) blockers.push("검수 뒤에 합성이 바뀌었습니다. 검수를 다시 실행하세요");
  const errs = openErrors(qa);
  if (errs.length) blockers.push(`자동 검수 오류 ${errs.length}개: 고치거나 사유를 적고 넘기세요`);
  const left = humanChecklist(qa).filter((h) => !qa.human[h]);
  if (left.length) blockers.push(`사람 확인 ${left.length}개 남음: ${left.join(", ")}`);
  return { ok: blockers.length === 0, blockers };
}

/* ------------------------------------------------------------------ */
/* 4. 보고서                                                             */
/* ------------------------------------------------------------------ */

const SEV: Record<QaSeverity, string> = { error: "오류", warning: "경고", info: "정보" };
const LLM_STATUS: Record<LlmQaStatus, string> = {
  done: "완료",
  unsupported: "이 연결 방식은 이미지 검수 미지원 (사람이 확인)",
  failed: "실패 (사람이 확인)",
  skipped: "하지 않음 (사람이 확인)",
};

export function renderQaMarkdown(qa: QaDoc, company: string): string {
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/\r?\n/g, " ");
  const row = (c: QaCheck) => {
    const o = qa.overrides[c.id];
    return `| ${SEV[c.severity]} | ${c.source === "rule" ? "규칙" : "이미지(LLM)"} | ${cell(c.where)} | ${cell(c.message)} | ${o ? cell(`넘김: ${o.reason} (${o.by})`) : ""} |`;
  };
  const human = humanChecklist(qa);
  return [
    `# 검수 보고서 — ${company}`,
    "",
    `- 검수 시각: ${qa.ranAt} (${qa.ranBy})`,
    `- 심의 업종: ${qa.review ? "예 (카피 사전 점검·완성본 심의 필요)" : "아니오"}`,
    `- 이미지 검수(LLM): ${LLM_STATUS[qa.llm.status]}${qa.llm.model ? ` · 모델 ${qa.llm.model}` : ""}${qa.llm.note ? ` · ${qa.llm.note}` : ""}`,
    qa.llm.overall ? `- 이미지 검수 총평 [AI 초안]: ${qa.llm.overall}` : "",
    "- 검수는 결과 PNG만 보고 했다. 최종 판단은 게이트 2에서 사람이 한다.",
    "",
    "## 자동 검수",
    "",
    "| 구분 | 출처 | 위치 | 내용 | 처리 |",
    "|---|---|---|---|---|",
    ...qa.checks.filter((c) => c.severity !== "info").map(row),
    ...qa.checks.filter((c) => c.severity === "info").map(row),
    "",
    "## 사람 확인 (게이트 2)",
    "",
    ...human.map((h) => `- [${qa.human[h] ? "x" : " "}] ${h}${qa.human[h] ? ` (${qa.human[h].by})` : ""}`),
    "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}
