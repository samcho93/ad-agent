import { z } from "zod/v4";
import { type Intake, type QuestionNo, isUnknown, intakeCorpus, bannedPhrases, OBJECTIVES } from "./intake";
import { type Tag, renderTags, withEstimate, markEstimated, hasTag } from "./tags";
import { type Issue, factIssues, quoteSupported, reviewIndustryHits, unsupportedNumbers, vagueTarget } from "./validate";
import type { Settings } from "./settings";

/* ------------------------------------------------------------------ */
/* 1. 모델 출력 스키마 (구조화된 출력)                                     */
/* ------------------------------------------------------------------ */

const Field = z.object({
  content: z.string().describe("이 항목의 내용. 1부에 없는 사실은 쓰지 않는다."),
  estimated: z.boolean().describe("1부 답이 '모르겠음'이거나 AI가 추정해서 채웠으면 true"),
});

export const OBJECTIVE_CATEGORIES = ["매출", "문의·상담", "회원가입", "방문·인지"] as const;
export type ObjectiveCategory = (typeof OBJECTIVE_CATEGORIES)[number];

export const BriefModelOutput = z.object({
  client: Field.describe("광고주·제품: 이름과 한 줄 설명"),
  background: Field.describe("배경: 현재 상황 2~3줄 (1부 4번 기반)"),
  problem: Field.describe("풀어야 할 문제: '~ 때문에 ~가 안 된다' 한 문장"),
  objective: z.object({
    category: z.enum(OBJECTIVE_CATEGORIES).describe("광고 목적 4종 중 하나. 사이트·매장 방문은 방문·인지"),
    kpi: z.string().describe("핵심 KPI와 목표 숫자. 광고주가 목표를 주지 않았으면 '목표 숫자 확인 필요'"),
    estimated: z.boolean(),
  }),
  review: z.object({
    status: z.enum(["대상", "비대상", "확인 필요"]),
    reason: z.string(),
  }),
  target: Field.describe("타깃: 나이·상황·관심사 한 줄. '모두' 금지"),
  insightCandidates: z.array(z.string()).describe("소비자 인사이트 후보 정확히 3개. '사람들은 ~하지만 실제로는 ~하다'"),
  competition: Field.describe("경쟁·대안: 소비자가 대신 고를 수 있는 것"),
  competitorsNeedCapture: z.array(z.string()).describe("로그인해야 내용이 보이는 경쟁사 이름(인스타그램 등). 내용을 읽었다고 하지 않는다"),
  benefit: Field.describe("핵심 혜택: 경쟁사가 말하기 어려운 것 하나"),
  evidence: z.object({
    status: z.enum(["있음", "근거 없음"]),
    quotes: z.array(z.string()).describe("1부 6번 답에서 그대로 옮긴 수치·후기·수상 문구만. 없으면 빈 배열"),
  }),
  keyMessageCandidates: z.array(z.string()).describe("핵심 메시지 후보 2~3개"),
  ctaCandidates: z.array(z.string()).describe("CTA 버튼 문구 후보 2~3개"),
  tone: Field.describe("톤·비주얼 방향: 말투·분위기·색·구도. 1부 8번 레퍼런스 우선"),
  mediaEstimate: z.string().describe("1부 11번이 '모르겠음'일 때만: 추천 매체와 이유. 아니면 빈 문자열"),
});
export type BriefModelOutput = z.infer<typeof BriefModelOutput>;

/* ------------------------------------------------------------------ */
/* 2. 브리프 문서                                                        */
/* ------------------------------------------------------------------ */

export type Area = "문제 정의" | "타깃" | "메시지" | "아이디어·비주얼" | "제작 조건";

export interface BriefRow {
  id: string;
  area: Area;
  label: string;
  content: string;
  candidates?: string[];
  tags: Tag[];
  estimated: boolean;
}

export interface ChecklistItem {
  id: string; // = row id
  label: string;
  reasons: string[]; // 사용자 결정 / 추정 / 심의 확인 필요 / 근거 없음 / 검증: ...
}

export interface Decision {
  value: string;
  decidedBy: string;
  decidedAt: string;
}

export interface BriefDoc {
  version: 1;
  generatedAt: string;
  model: string;
  objectiveCategory: ObjectiveCategory;
  objectiveEstimated: boolean;
  reviewStatus: "대상" | "비대상" | "확인 필요";
  evidenceStatus: "있음" | "근거 없음";
  evidenceQuotes: string[];
  hasProduct: boolean;
  rows: BriefRow[];
  issues: Issue[];
  checklist: ChecklistItem[];
  decisions: Record<string, Decision>;
}

const anyUnknown = (intake: Intake, qs: QuestionNo[]) => qs.some((q) => isUnknown(intake, q));

/** 3번 답을 목적 4종으로. 모르겠음이면 null */
export function objectiveFromIntake(intake: Intake): ObjectiveCategory | null {
  const a = intake.answers["3"];
  if (a.unknown || !a.choice) return null;
  return a.choice === "사이트·매장 방문" ? "방문·인지" : (a.choice as Exclude<(typeof OBJECTIVES)[number], "사이트·매장 방문">);
}

/** 이미지 방침 후보 (ad-image-router 1단계 표). 코드가 정하고 사람이 확인한다. */
export function imagePolicyCandidates(intake: Intake): string[] {
  const has = intake.answers["9"].hasProduct;
  const assets = intake.answers["10"].unknown ? [] : intake.answers["10"].assets;
  const productPhoto = assets.includes("제품 사진");
  const shopPhoto = assets.includes("매장·공간 사진");
  if (has && productPhoto)
    return [
      "제품형, 사진 있음: 원본에서 제품을 오려(누끼) 그대로 쓰고 배경·그림자·소품만 AI 생성 (기본, 가장 안전)",
      "제품형, 원본 기반 재생성: 원본을 참조로 AI 재생성, 원본과 나란히 비교 검수 필수 (다르면 폐기)",
    ];
  if (has)
    return ["제품형, 사진 없음: 광고주에게 제품 사진 요청. AI로 제품을 새로 그리지 않음"];
  return [
    "무형: 공간·사람·상황·상징 이미지를 AI로 생성 (글자·로고 없이)",
    shopPhoto ? "무형: 광고주의 실제 매장·공간 사진 사용" : "무형: 실제 매장·공간 사진 요청 후 사용",
  ];
}

function copyText(v: string, fallback = "없음") {
  return v.trim() || fallback;
}

/**
 * 모델 출력 + 1부 답 → 브리프 문서.
 * 태그와 "추정" 표시는 여기서 코드가 붙인다. 모델이 빠뜨려도 규칙이 지켜진다.
 */
export function buildBrief(intake: Intake, out: BriefModelOutput, settings: Settings, model: string): BriefDoc {
  const corpus = intakeCorpus(intake);
  const banned = bannedPhrases(intake);
  const issues: Issue[] = [];
  const rows: BriefRow[] = [];
  const a = intake.answers;

  const push = (r: Omit<BriefRow, "estimated" | "tags"> & { tags: Tag[]; estimated?: boolean }) => {
    const estimated = Boolean(r.estimated);
    // 후보형 항목은 내용이 안내문이라 태그로만 표시한다
    const content = r.candidates?.length ? r.content : markEstimated(r.content, estimated);
    rows.push({ ...r, estimated, tags: withEstimate(r.tags, estimated), content });
  };

  const llmField = (id: string, area: Area, label: string, f: { content: string; estimated: boolean }, tags: Tag[], sources: QuestionNo[]) => {
    const estimated = f.estimated || anyUnknown(intake, sources);
    push({ id, area, label, content: f.content.trim(), tags, estimated });
    issues.push(...factIssues(id, f.content, corpus, banned, { copy: false }));
  };

  /* 문제 정의 */
  llmField("client", "문제 정의", "광고주·제품", out.client, [{ kind: "intake", qs: [0, 1] }], []);
  push({
    id: "deliverable",
    area: "문제 정의",
    label: "산출물 유형",
    content: "배너(1차). 숏폼·랜딩은 추후",
    candidates: ["배너만 (1차)", "배너 + 숏폼·랜딩 (추후 추가)"],
    tags: [{ kind: "user" }],
  });
  push({
    id: "productType",
    area: "문제 정의",
    label: "제품 유무",
    content: a["9"].hasProduct ? "제품형" : "무형 (서비스·가게·병원·금융 등)",
    tags: [{ kind: "intake", qs: [9] }],
  });

  // 심의: 키워드에 걸리면 모델이 "비대상"이라 해도 "확인 필요"로 올린다
  const industryHits = reviewIndustryHits(corpus);
  let reviewStatus = out.review.status;
  if (industryHits.length && reviewStatus === "비대상") {
    reviewStatus = "확인 필요";
    issues.push({ severity: "warning", where: "review", message: `심의 업종 키워드(${industryHits.join(", ")})가 있어 '확인 필요'로 올림` });
  }
  push({
    id: "review",
    area: "문제 정의",
    label: "심의 대상 여부",
    content: `${reviewStatus}. ${out.review.reason.trim()}`,
    tags: [{ kind: "ai" }],
  });
  llmField("background", "문제 정의", "배경", out.background, [{ kind: "ai", basedOn: [4] }], [4]);
  llmField("problem", "문제 정의", "풀어야 할 문제", out.problem, [{ kind: "ai" }], [4]);

  // 목적: 3번 답이 있으면 그 값을 쓴다 (모델이 바꾸지 못하게)
  const fromIntake = objectiveFromIntake(intake);
  const objectiveCategory = fromIntake ?? out.objective.category;
  // 목적(방향표 행을 정함)의 추정 여부와 KPI의 추정 여부를 나눈다
  const objectiveEstimated = fromIntake === null;
  if (fromIntake && fromIntake !== out.objective.category) {
    issues.push({ severity: "warning", where: "objective", message: `모델이 목적을 '${out.objective.category}'로 바꾸려 해서 1부 3번 답 '${fromIntake}'로 고정함` });
  }
  // KPI 목표 숫자를 광고주가 주지 않았는데 숫자가 있으면 AI가 제안한 값이다 → 추정으로 표시
  const kpiInvented = unsupportedNumbers(out.objective.kpi, corpus).length > 0;
  if (kpiInvented) issues.push({ severity: "warning", where: "objective", message: "KPI 목표 숫자는 광고주가 준 값이 아님 (AI 제안, 추정)" });
  const kpiEstimated = out.objective.estimated || kpiInvented;
  const kpi = out.objective.kpi.trim();
  push({
    id: "objective",
    area: "문제 정의",
    label: "광고 목적·핵심 KPI",
    content: `목적: ${objectiveCategory}${objectiveEstimated ? " (추정: 1부 3번 모르겠음, 1~2번으로 추정)" : ""}. KPI: ${kpi}${kpiEstimated && !kpi.includes("추정") ? " (추정)" : ""}`,
    tags: [{ kind: "intake", qs: [3] }],
    estimated: objectiveEstimated || kpiEstimated,
  });
  issues.push(...factIssues("objective", out.objective.kpi, corpus, banned, { allowNumbers: true, copy: false }));

  /* 타깃 */
  llmField("target", "타깃", "타깃", out.target, [{ kind: "ai", basedOn: [2] }], [2]);
  if (vagueTarget(out.target.content)) issues.push({ severity: "error", where: "target", message: "타깃에 '모두/누구나' 같은 표현은 쓸 수 없음" });
  push({
    id: "insight",
    area: "타깃",
    label: "소비자 인사이트",
    content: "후보 중 사람이 고른다",
    candidates: out.insightCandidates.map((s) => s.trim()).filter(Boolean),
    tags: [{ kind: "user" }],
    estimated: anyUnknown(intake, [2, 4]),
  });
  if (out.insightCandidates.length !== 3) issues.push({ severity: "error", where: "insight", message: `인사이트 후보는 3개여야 함 (현재 ${out.insightCandidates.length}개)` });
  for (const c of out.insightCandidates) issues.push(...factIssues("insight", c, corpus, banned, { copy: false }));

  /* 메시지 */
  let competition = out.competition.content.trim();
  if (out.competitorsNeedCapture.length) {
    competition += ` (로그인이 필요한 곳은 내용을 확인하지 않음, 캡처 요청: ${out.competitorsNeedCapture.join(", ")})`;
  }
  llmField("competition", "메시지", "경쟁·대안", { content: competition, estimated: out.competition.estimated }, [{ kind: "intake", qs: [5] }], [5]);
  llmField("benefit", "메시지", "핵심 혜택", out.benefit, [{ kind: "ai", basedOn: [6] }], [6]);

  // 근거: 1부 6번 문구에 실제로 있는 것만 남긴다
  const q6 = a["6"].unknown ? "" : a["6"].text;
  const quotes = out.evidence.quotes.map((q) => q.trim()).filter(Boolean);
  const supported = quotes.filter((q) => quoteSupported(q, q6));
  const dropped = quotes.filter((q) => !supported.includes(q));
  if (dropped.length) issues.push({ severity: "warning", where: "evidence", message: `1부 6번에 없는 근거를 뺌: ${dropped.join(" / ")}` });
  const evidenceStatus: "있음" | "근거 없음" = supported.length ? "있음" : "근거 없음";
  push({
    id: "evidence",
    area: "메시지",
    label: "근거",
    content: evidenceStatus === "있음" ? supported.map((q) => `"${q}"`).join(", ") : "근거 없음 (광고주에게 후기·수치·수상 자료 보완 요청)",
    tags: [{ kind: "intake", qs: [6] }],
  });
  push({
    id: "keyMessage",
    area: "메시지",
    label: "핵심 메시지",
    content: "후보 중 사람이 고른다",
    candidates: out.keyMessageCandidates.map((s) => s.trim()).filter(Boolean),
    tags: [{ kind: "user" }],
    estimated: objectiveEstimated && fromIntake === null,
  });
  if (out.keyMessageCandidates.length < 2) issues.push({ severity: "error", where: "keyMessage", message: "핵심 메시지 후보는 2개 이상이어야 함" });
  for (const c of out.keyMessageCandidates) issues.push(...factIssues("keyMessage", c, corpus, banned));
  push({
    id: "cta",
    area: "메시지",
    label: "원하는 행동(CTA)",
    content: "후보 중 사람이 고른다",
    candidates: out.ctaCandidates.map((s) => s.trim()).filter(Boolean),
    tags: [{ kind: "user" }],
  });
  if (out.ctaCandidates.length < 2) issues.push({ severity: "error", where: "cta", message: "CTA 후보는 2개 이상이어야 함" });
  for (const c of out.ctaCandidates) issues.push(...factIssues("cta", c, corpus, banned));

  /* 아이디어·비주얼 */
  llmField("tone", "아이디어·비주얼", "톤·비주얼 방향", out.tone, [{ kind: "ai" }], []);
  push({
    id: "imagePolicy",
    area: "아이디어·비주얼",
    label: "이미지 사용 방침",
    content: "ad-image-router 기준 후보. 광고주 확인 필요",
    candidates: imagePolicyCandidates(intake),
    tags: [{ kind: "user" }],
    estimated: isUnknown(intake, 10),
  });

  /* 제작 조건 */
  const q7 = a["7"];
  push({
    id: "mustAvoid",
    area: "제작 조건",
    label: "필수·금지 표현",
    content: q7.unknown ? "특별히 없음으로 가정, 광고주 확인 필요" : `꼭 넣을 말: ${copyText(q7.must)} / 쓰면 안 되는 말: ${copyText(q7.avoid)}`,
    tags: [{ kind: "intake", qs: [7] }],
    estimated: q7.unknown,
  });
  const q10 = a["10"];
  push({
    id: "materials",
    area: "제작 조건",
    label: "제작 자료",
    content: q10.unknown ? "자료 없음으로 가정, 광고주 확인 필요" : [q10.assets.join(", "), q10.text.trim()].filter(Boolean).join(" / ") || "없음",
    tags: [{ kind: "intake", qs: [10] }],
    estimated: q10.unknown,
  });
  const q11 = a["11"];
  push({
    id: "media",
    area: "제작 조건",
    label: "매체·규격·집행 기간",
    content: q11.unknown
      ? `${out.mediaEstimate.trim() || "매체 미정"}. 규격: 매체 확정 후 결정. 집행 기간: 미정`
      : `${q11.channels.join(", ") || "미정"}. 규격: 매체 확정 후 결정. 집행 기간: 미정`,
    tags: [{ kind: "intake", qs: [11] }],
    estimated: q11.unknown,
  });
  if (q11.unknown) issues.push(...factIssues("media", out.mediaEstimate, corpus, banned, { copy: false }));
  push({
    id: "delivery",
    area: "제작 조건",
    label: "납품 형태",
    content: "매체별 파일 형식·용량은 매체 확정 후 결정",
    candidates: ["매체별 PNG", "매체별 JPG", "PNG + JPG 모두"],
    tags: [{ kind: "user" }],
  });
  push({
    id: "variants",
    area: "제작 조건",
    label: "시안 개수",
    content: `기본 ${settings.defaultVariants}종 (같은 아이디어에서 메시지·버튼 문구·버튼 색만 다른 변형)`,
    candidates: [`${settings.defaultVariants}종 (기본)`],
    tags: [{ kind: "user" }],
  });
  push({
    id: "revisions",
    area: "제작 조건",
    label: "수정 범위",
    content: `포함 횟수: ${settings.revision.includedCount} (${settings.revision.includedCountRange} 중 결정 필요). 콘셉트 변경은 새 시안`,
    tags: [{ kind: "user" }],
  });
  push({
    id: "testIdeas",
    area: "제작 조건",
    label: "테스트 아이디어",
    content: "ad-ideation 단계에서 최소 3종(메시지와 비주얼 콘셉트 한 쌍)으로 채움",
    tags: [{ kind: "ai" }],
  });

  const doc: BriefDoc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    model,
    objectiveCategory,
    objectiveEstimated,
    reviewStatus,
    evidenceStatus,
    evidenceQuotes: supported,
    hasProduct: a["9"].hasProduct,
    rows,
    issues: dedupeIssues(issues),
    checklist: [],
    decisions: {},
  };
  doc.checklist = buildChecklist(doc);
  return doc;
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.where}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 사람이 확정할 항목: 모든 [사용자 결정], 모든 [추정], 심의 확인 필요, 근거 없음, 검증 문제 */
export function buildChecklist(doc: BriefDoc): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const r of doc.rows) {
    const reasons: string[] = [];
    if (hasTag(r.tags, "user")) reasons.push("사용자 결정");
    if (hasTag(r.tags, "estimate")) reasons.push("추정");
    if (r.id === "review" && doc.reviewStatus !== "비대상") reasons.push(`심의 ${doc.reviewStatus}`);
    if (r.id === "evidence" && doc.evidenceStatus === "근거 없음") reasons.push("근거 없음");
    for (const i of doc.issues.filter((i) => i.where === r.id)) reasons.push(`${i.severity === "error" ? "검증 오류" : "검증 경고"}: ${i.message}`);
    if (reasons.length) items.push({ id: r.id, label: r.label, reasons });
  }
  return items;
}

export function errorCount(doc: Pick<BriefDoc, "issues">): number {
  return doc.issues.filter((i) => i.severity === "error").length;
}

export function unresolved(doc: BriefDoc): ChecklistItem[] {
  return doc.checklist.filter((c) => !doc.decisions[c.id]);
}

/** 확정값이 있으면 그 값을, 없으면 초안 내용을 쓴다 (아이디어 단계 입력용) */
export function effectiveValue(doc: BriefDoc, rowId: string): string {
  const d = doc.decisions[rowId];
  if (d) return d.value;
  const r = doc.rows.find((x) => x.id === rowId);
  if (!r) return "";
  return r.candidates?.length ? `미확정. 후보: ${r.candidates.join(" / ")}` : r.content;
}

/* ------------------------------------------------------------------ */
/* 3. 02_brief.md 렌더                                                   */
/* ------------------------------------------------------------------ */

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

export function renderBriefMarkdown(doc: BriefDoc, company: string, opts?: { final?: boolean }): string {
  const lines: string[] = [];
  lines.push(`# 광고 브리프 (2부) — ${company}`);
  lines.push("");
  lines.push(opts?.final ? "> 상태: **확정** (게이트 1 승인). 내부 문서." : "> 상태: **AI 초안**. 사람이 확정하기 전에는 이미지 단계로 넘어가지 않는다. 내부 문서.");
  lines.push(`> 생성: ${doc.generatedAt} · 모델: ${doc.model}`);
  lines.push("");
  lines.push("| 영역 | 항목 | 내용 | 태그 |");
  lines.push("|---|---|---|---|");
  for (const r of doc.rows) {
    const d = doc.decisions[r.id];
    let content = r.content;
    if (r.candidates?.length) content += `<br>후보: ${r.candidates.map((c, i) => `${"①②③④⑤⑥"[i] ?? i + 1} ${c}`).join(" ")}`;
    let tags = r.tags;
    if (d) {
      content = `**확정:** ${d.value}<br><sub>초안: ${content}</sub>`;
      if (!hasTag(tags, "user")) tags = [...tags, { kind: "user" }];
    }
    lines.push(`| ${r.area} | ${r.label} | ${cell(content)} | ${renderTags(tags)} |`);
  }
  lines.push("");
  lines.push("## 사람이 확정할 항목");
  lines.push("");
  if (!doc.checklist.length) lines.push("- 없음");
  for (const c of doc.checklist) {
    const d = doc.decisions[c.id];
    lines.push(`- [${d ? "x" : " "}] **${c.label}** — ${c.reasons.join(" · ")}${d ? ` → 확정: ${d.value} (${d.decidedBy}, ${d.decidedAt})` : ""}`);
  }
  const other = doc.issues.filter((i) => !doc.rows.some((r) => r.id === i.where));
  if (other.length) {
    lines.push("");
    lines.push("## 기타 검증 메모");
    for (const i of other) lines.push(`- (${i.severity}) ${i.where}: ${i.message}`);
  }
  lines.push("");
  return lines.join("\n");
}
