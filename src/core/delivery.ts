import { z } from "zod/v4";
import { SIZES, type Variant } from "./compose";

/**
 * MVP 4단계: 광고주 시안 확인(파일 주고받기), 수정 기록, 완성본 심의, 납품.
 * 광고주는 로그인 없이 "시안 확인 파일"을 사이트의 확인 화면에서 열고, 답변 파일을 돌려준다.
 */

export const REVISION_KINDS = ["글자", "색", "위치", "크기", "이미지 교체", "콘셉트 변경"] as const;
export type RevisionKind = (typeof REVISION_KINDS)[number];

export interface ProofRecord {
  id: string;
  round: number;
  createdAt: string;
  createdBy: string;
  composeUpdatedAt: string;
}

export interface AnswerRecord {
  proofId: string;
  importedAt: string;
  importedBy: string;
  answeredAt: string;
  decision: "confirm" | "revise";
  variant: Variant | null;
  requests: { kind: RevisionKind; detail: string }[];
  comment: string;
}

export interface RevisionRecord {
  at: string;
  by: string;
  round: number;
  source: "광고주" | "심의" | "내부";
  kinds: RevisionKind[];
  detail: string;
  /** 콘셉트 변경은 수정이 아니라 새 시안 */
  type: "수정" | "새 시안";
  /** 포함 수정 횟수에 넣는지. null = 미정 (심의 수정 등) */
  counted: boolean | null;
}

export interface FinalReview {
  result: "통과" | "수정 필요";
  date: string;
  memo: string;
  by: string;
  at: string;
}

export interface DeliveryDoc {
  version: 1;
  proofs: ProofRecord[];
  answers: AnswerRecord[];
  selectedVariant: Variant | null;
  finalReview: FinalReview | null;
  revisions: RevisionRecord[];
  delivered: { at: string; by: string; variant: Variant; files: string[] } | null;
}

export const emptyDelivery = (): DeliveryDoc => ({ version: 1, proofs: [], answers: [], selectedVariant: null, finalReview: null, revisions: [], delivered: null });

/** 콘셉트 변경이 들어 있으면 새 시안 */
export const revisionType = (kinds: readonly RevisionKind[]): RevisionRecord["type"] => (kinds.includes("콘셉트 변경") ? "새 시안" : "수정");

/** 이미지를 바꿔야 하면 이미지 단계부터, 아니면 합성 단계부터 */
export const reopenStage = (kinds: readonly RevisionKind[]) => (kinds.some((k) => k === "이미지 교체" || k === "콘셉트 변경") ? "images" : "compose");

export function revisionCount(doc: DeliveryDoc, included: string | number) {
  const used = doc.revisions.filter((r) => r.counted === true).length;
  const unknown = doc.revisions.filter((r) => r.counted === null).length;
  const newDrafts = doc.revisions.filter((r) => r.type === "새 시안").length;
  return { used, unknown, newDrafts, included, over: typeof included === "number" && used > included };
}

/* ---------------- 파일 형식 ---------------- */

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const short = (n: number) => z.string().max(n);

const VariantProof = z.object({
  headline: short(200),
  sub: short(400),
  cta: short(60),
  /** 사이즈별 PNG (data URL). 화면에서 <img> 로만 쓴다 */
  images: z.partialRecord(z.enum(SIZES), z.string().max(12 * 1024 * 1024).regex(PNG_DATA_URL)),
});

/** 광고주에게 보내는 시안 확인 파일. 개인정보(담당자 이름·연락처)는 넣지 않는다 */
export const ProofFileSchema = z.object({
  format: z.literal("ad-agent-proof"),
  version: z.literal(1),
  proofId: short(80),
  caseId: short(80),
  company: short(100),
  round: z.number().int().min(1).max(99),
  createdAt: short(40),
  note: short(500),
  variants: z.object({ A: VariantProof, B: VariantProof }),
});
export type ProofFile = z.infer<typeof ProofFileSchema>;

/** 광고주가 돌려주는 답변 파일 */
export const ProofAnswerSchema = z
  .object({
    format: z.literal("ad-agent-proof-answer"),
    version: z.literal(1),
    proofId: short(80),
    caseId: short(80),
    answeredAt: short(40),
    decision: z.enum(["confirm", "revise"]),
    variant: z.enum(["A", "B"]).nullable(),
    requests: z.array(z.object({ kind: z.enum(REVISION_KINDS), detail: short(1000) })).max(10),
    comment: short(2000),
  })
  .refine((a) => a.decision !== "confirm" || a.variant !== null, { message: "확정한 시안(A/B)이 없습니다" })
  .refine((a) => a.decision !== "revise" || a.requests.length > 0, { message: "수정 요청 내용이 없습니다" });
export type ProofAnswer = z.infer<typeof ProofAnswerSchema>;

export const PROOF_NOTE = "시안 A와 B는 그림과 배치가 같고, 문구와 버튼만 다릅니다. 더 마음에 드는 쪽을 골라 주세요.";

/* ---------------- 기록 문서 ---------------- */

export function renderRevisionLine(r: RevisionRecord, included: string | number): string {
  const counted = r.type === "새 시안" ? "새 시안 (수정 횟수 아님, 별도 협의)" : r.counted === null ? "포함 여부 미정" : r.counted ? `수정 횟수에 포함 (포함 수정 횟수: ${included})` : "수정 횟수 제외";
  const clean = (s: string) => s.replace(/\r?\n/g, " ").trim();
  return `- ${r.at} | ${r.round}차 | ${r.source} | ${r.type} | ${r.kinds.join(", ")} | ${clean(r.detail) || "-"} | ${counted} | ${clean(r.by)}\n`;
}

export function deliveryReadme(company: string, variant: Variant, files: string[], review: boolean, finalReview: FinalReview | null) {
  return [
    `광고 시안 납품 — ${company}`,
    "",
    `선택 시안: ${variant}`,
    `납품 시각: ${new Date().toISOString()}`,
    review ? `완성본 심의: ${finalReview ? `${finalReview.result} (${finalReview.date})` : "기록 없음"}` : "심의 업종 아님",
    "",
    "들어 있는 파일",
    ...files.map((f) => `- ${f}`),
    "",
    "안내",
    "- 이미지 안의 문구와 로고는 합성 단계에서 폰트(Pretendard, SIL OFL 1.1)와 광고주 원본 로고로 얹었습니다.",
    "- 검수 보고서(qa_report.md)와 승인 기록(approvals.md), 수정 기록(revisions.md)을 함께 넣었습니다.",
    "",
  ].join("\r\n");
}
