import { z } from "zod/v4";
import type { BriefDoc } from "./brief";
import type { Intake } from "./intake";
import type { Idea } from "./ideas";
import { reviewIndustryHits, visualTextHits, type Issue } from "./validate";
import { intakeCorpus } from "./intake";

/* ------------------------------------------------------------------ */
/* 1. 경로 (ad-image-router 1단계 표)                                     */
/* ------------------------------------------------------------------ */

export type ImageRoute =
  | "product_cutout" // 제품형, 사진 있음: 누끼 + 배경만 생성 (기본, 가장 안전)
  | "product_regenerate" // 제품형, 원본 기반 재생성: 원본과 나란히 비교 검수 필수
  | "product_need_photo" // 제품형, 사진 없음: 사진 요청. AI로 제품을 그리지 않음
  | "intangible_ai" // 무형: 공간·사람·상황·상징 이미지 생성
  | "intangible_photo"; // 무형: 실제 매장·공간 사진

export const ROUTE_LABEL: Record<ImageRoute, string> = {
  product_cutout: "제품형, 사진 있음 → 원본에서 제품을 오려(누끼) 그대로 쓰고 배경·그림자·소품만 생성",
  product_regenerate: "제품형, 원본 기반 재생성 → 원본과 나란히 비교 검수 필수, 다르면 폐기",
  product_need_photo: "제품형, 사진 없음 → 광고주에게 사진 요청 (AI로 제품을 새로 그리지 않음)",
  intangible_ai: "무형 → 공간·사람·상황·상징 이미지를 생성",
  intangible_photo: "무형 → 실제 매장·공간 사진 사용",
};

export interface ImagePolicy {
  route: ImageRoute;
  reason: string;
  /** 병원 등 의료: 시술·전후 비교로 보이는 이미지 금지, 내부는 실제 사진 권장 */
  medical: boolean;
  /** 심의 대상/확인 필요 */
  review: string;
  /** 광고주에게 확인·요청할 것 */
  clientRequests: string[];
  /** 진행을 막는 것 (사람이 풀어야 함) */
  blockers: string[];
  /** ad-qa 에 넘길 검수 기준 */
  qaCriteria: string[];
  decidedAt: string;
}

/** 확정된 "이미지 사용 방침" 문구 → 경로 */
export function routeFromDecision(text: string, hasProduct: boolean): ImageRoute {
  if (hasProduct) {
    if (/사진 없음|사진 요청/.test(text)) return "product_need_photo";
    if (/재생성/.test(text)) return "product_regenerate";
    return "product_cutout";
  }
  return /실제 (매장|공간)|실제 사진|매장·공간 사진/.test(text) ? "intangible_photo" : "intangible_ai";
}

export function buildPolicy(intake: Intake, brief: BriefDoc, assets: Asset[]): ImagePolicy {
  const decided = brief.decisions.imagePolicy?.value ?? "";
  const hasProduct = brief.hasProduct;
  let route = routeFromDecision(decided, hasProduct);
  const productPhotos = assets.filter((a) => a.kind === "product");
  const shopPhotos = assets.filter((a) => a.kind === "shop");
  const medical = reviewIndustryHits(intakeCorpus(intake)).includes("의료");
  const blockers: string[] = [];
  const clientRequests: string[] = [];

  if (!decided) blockers.push("브리프의 '이미지 사용 방침'이 확정되지 않았습니다");
  if (route === "product_need_photo") {
    blockers.push("제품형인데 제품 사진이 없습니다. 광고주에게 사진을 요청하세요 (AI로 제품을 새로 그리지 않습니다)");
    clientRequests.push("제품 사진 (정면, 비스듬한 각도, 가능하면 밝은 단색 배경)");
  }
  if ((route === "product_cutout" || route === "product_regenerate") && productPhotos.length === 0) {
    blockers.push("제품 사진 파일을 올려야 합니다 (자료 > 제품 사진)");
  }
  if (route === "intangible_photo" && shopPhotos.length === 0) {
    blockers.push("실제 매장·공간 사진 파일을 올려야 합니다 (자료 > 매장·공간 사진)");
    clientRequests.push("실제 매장·공간 사진");
  }
  if (medical) clientRequests.push("병원 내부 실제 사진 (시술 장면·전후 비교처럼 보이는 AI 이미지는 쓰지 않음)");
  if (!assets.some((a) => a.kind === "logo")) clientRequests.push("로고 원본 파일 (합성 단계에서 얹음, AI로 만들지 않음)");

  const qaCriteria = [
    "이미지 안에 글자·간판·로고·워터마크가 생성되어 있지 않다",
    "문구와 버튼을 얹을 빈 공간이 아이디어에서 정한 위치에 있다",
  ];
  if (route === "product_cutout") qaCriteria.push("누끼 결과의 제품 모양·포장 글자·로고·무늬·색이 원본과 같다 (가장자리만 다를 수 있음)");
  if (route === "product_regenerate") qaCriteria.push("원본과 나란히 놓고 포장 글자·로고·무늬·색을 비교했다. 다르면 폐기한다");
  if (route === "product_cutout") qaCriteria.push("배경 이미지에 제품이 새로 그려져 있지 않다 (제품은 원본 누끼만 사용)");
  if (medical) qaCriteria.push("시술 장면, 전후 비교, 효과 보장으로 오인될 장면이 없다");
  if (brief.reviewStatus !== "비대상") qaCriteria.push(`심의(${brief.reviewStatus}): 완성본 심의에서 이미지도 대상일 수 있음`);

  if (route === "product_regenerate") clientRequests.push("재생성 이미지가 원본과 같은지 광고주 확인");

  return {
    route,
    reason: decided ? `브리프에서 확정한 이미지 사용 방침: "${decided}"` : "이미지 사용 방침 미확정",
    medical,
    review: brief.reviewStatus,
    clientRequests,
    blockers,
    qaCriteria,
    decidedAt: new Date().toISOString(),
  };
}

export function renderPolicyMarkdown(p: ImagePolicy, company: string): string {
  const L = [
    `# 이미지 방침 — ${company}`,
    "",
    `- 경로: **${ROUTE_LABEL[p.route]}**`,
    `- 이유: ${p.reason}`,
    `- 심의: ${p.review}${p.medical ? " · 의료(병원) — 시술·전후 비교로 보이는 AI 이미지 금지, 내부는 실제 사진 권장" : ""}`,
    `- 정한 시각: ${p.decidedAt}`,
    "",
    "## 진행을 막는 것",
    ...(p.blockers.length ? p.blockers.map((b) => `- [ ] ${b}`) : ["- 없음"]),
    "",
    "## 광고주 확인·요청",
    ...(p.clientRequests.length ? p.clientRequests.map((b) => `- ${b}`) : ["- 없음"]),
    "",
    "## 검수 기준 (ad-qa 에 전달)",
    ...p.qaCriteria.map((b) => `- ${b}`),
    "",
    "공통: 모든 이미지 프롬프트에 '글자, 간판, 로고, 워터마크 넣지 말 것'을 고정으로 넣는다. 한글 카피와 로고는 합성 단계에서 얹는다.",
    "",
  ];
  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* 2. 자료와 이미지 기록                                                  */
/* ------------------------------------------------------------------ */

export type AssetKind = "product" | "shop" | "logo" | "other";
export const ASSET_KIND_LABEL: Record<AssetKind, string> = { product: "제품 사진", shop: "매장·공간 사진", logo: "로고", other: "기타" };

export interface Asset {
  id: string;
  kind: AssetKind;
  file: string; // assets/<id>.<ext>
  originalName: string;
  mime: string;
  addedAt: string;
  addedBy: string;
}

export type ImageSource = "figma" | "upload" | "cutout";
export type ImageStatus = "candidate" | "picked" | "discarded";

export interface ImageItem {
  id: string;
  file: string; // 04_images/<id>.png
  source: ImageSource;
  /** 배경·장면 이미지인지, 제품 누끼인지 */
  role: "scene" | "cutout";
  tool: string; // 사용 도구 (절대 규칙 7)
  promptId?: string;
  figma?: { fileKey: string; nodeId: string };
  fromAssetId?: string; // 누끼의 원본 사진
  createdAt: string;
  createdBy: string;
  /** 사람이 확인: 도구의 상업 이용 허용 */
  commercialUseChecked: boolean;
  /** 검수 기준별 사람 확인 */
  checks: Record<string, boolean>;
  status: ImageStatus;
  note: string;
}

export interface ImagePrompt {
  id: string;
  ideaId: string;
  promptEn: string;
  promptKo: string;
  copySpace: string;
  aspect: string;
  model: string;
  createdAt: string;
  issues: Issue[];
}

export interface ImagesDoc {
  version: 1;
  policy: ImagePolicy | null;
  prompts: ImagePrompt[];
  assets: Asset[];
  items: ImageItem[];
}

export const emptyImagesDoc = (): ImagesDoc => ({ version: 1, policy: null, prompts: [], assets: [], items: [] });

/** 쓸 수 있는 이미지인지: 골랐고, 상업 이용 확인, 검수 기준 모두 체크 */
export function itemReady(item: ImageItem, policy: ImagePolicy | null): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!item.commercialUseChecked) missing.push(item.role === "cutout" ? "원본 사진 사용 권한 확인" : "도구의 상업 이용 허용 확인");
  for (const c of applicableCriteria(item, policy)) if (!item.checks[c]) missing.push(c);
  return { ok: missing.length === 0, missing };
}

/** 이미지 종류에 맞는 검수 기준만 (심의 안내는 체크 항목이 아님) */
export function applicableCriteria(item: ImageItem, policy: ImagePolicy | null): string[] {
  const all = (policy?.qaCriteria ?? []).filter((c) => !c.startsWith("심의("));
  const isCutoutCriterion = (c: string) => c.startsWith("누끼 결과");
  // 누끼는 원본 사진이라 포장에 원래 있던 글자·로고는 그대로 남는 게 맞다. 원본과 같은지만 본다
  return item.role === "cutout" ? all.filter(isCutoutCriterion) : all.filter((c) => !isCutoutCriterion(c));
}

/* ------------------------------------------------------------------ */
/* 3. 이미지 프롬프트 (모델 출력 스키마)                                  */
/* ------------------------------------------------------------------ */

export const ImagePromptModelOutput = z.object({
  promptEn: z.string().describe("이미지 생성 도구에 넣을 영어 프롬프트. 장면·구도·조명·분위기·색. 글자·간판·로고·워터마크를 묘사하지 않는다"),
  promptKo: z.string().describe("같은 내용의 한국어 설명 (사람이 검토용)"),
  copySpace: z.enum(["위", "아래", "왼쪽", "오른쪽"]).describe("문구와 버튼을 얹을 빈 공간 위치"),
  aspect: z.enum(["1:1", "16:9", "1.91:1"]).describe("권장 비율. 1080x1080은 1:1, 1200x628은 1.91:1"),
});
export type ImagePromptModelOutput = z.infer<typeof ImagePromptModelOutput>;

const COPY_SPACE_EN: Record<string, string> = { 위: "top", 아래: "bottom", 왼쪽: "left", 오른쪽: "right" };

/** 모든 프롬프트에 코드가 고정으로 붙이는 문장 (ad-image-router 3단계) */
export function fixedSuffix(route: ImageRoute, copySpace: string, medical: boolean): string {
  const parts = [
    `Leave a clean, uncluttered empty area at the ${COPY_SPACE_EN[copySpace] ?? "top"} of the frame for text and a button to be added later.`,
    "Absolutely no text, letters, numbers, signage, logos, labels, brand marks or watermarks anywhere in the image.",
  ];
  if (route === "product_cutout") parts.push("Do not draw the product itself. Create only the background, surface, lighting, shadows and props; the real product photo will be placed later.");
  if (medical) parts.push("No medical procedures, no before-and-after comparisons, no implied treatment results.");
  return parts.join(" ");
}

/** 영어 프롬프트에서 글자·로고를 넣으라는 표현 찾기 ("no text" 같은 부정은 허용) */
export function promptTextHits(en: string): string[] {
  const hits: string[] = [];
  const re = /\b(text|letters?|lettering|typography|logo|logos|signage|signs?|label|labels|watermark|caption|headline|words?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(en))) {
    const before = en.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    if (/\b(no|without|free of|avoid|never|not include|exclude|space for|area for|room for|copy space)\b[^.]*$/.test(before)) continue;
    hits.push(m[0]);
  }
  return [...new Set(hits.map((h) => h.toLowerCase()))];
}

/** 누끼 경로에서 제품을 그리라고 하는지 (제품명은 1부 1번 등에서) */
export function promptDrawsProduct(en: string, route: ImageRoute): boolean {
  if (route !== "product_cutout" && route !== "product_need_photo") return false;
  return /\b(product shot of|close-?up of (the )?(cookies?|product|bottle|package|box)|freshly baked cookies|plate of cookies)\b/i.test(en);
}

export function buildImagePrompt(out: ImagePromptModelOutput, idea: Idea, policy: ImagePolicy, model: string, id: string): ImagePrompt {
  const issues: Issue[] = [];
  const hitsEn = promptTextHits(out.promptEn);
  if (hitsEn.length) issues.push({ severity: "error", where: "prompt", message: `프롬프트에 글자·로고 묘사: ${hitsEn.join(", ")}` });
  const hitsKo = visualTextHits(out.promptKo);
  if (hitsKo.length) issues.push({ severity: "error", where: "prompt", message: `한국어 설명에 글자·로고 묘사: ${hitsKo.join(", ")}` });
  if (promptDrawsProduct(out.promptEn, policy.route)) {
    issues.push({ severity: "error", where: "prompt", message: "누끼 경로인데 프롬프트가 제품을 그리라고 합니다 (배경·소품만 생성해야 함)" });
  }
  return {
    id,
    ideaId: idea.id,
    promptEn: `${out.promptEn.trim()} ${fixedSuffix(policy.route, out.copySpace, policy.medical)}`,
    promptKo: out.promptKo.trim(),
    copySpace: out.copySpace,
    aspect: out.aspect,
    model,
    createdAt: new Date().toISOString(),
    issues,
  };
}

/* ------------------------------------------------------------------ */
/* 4. Figma 링크                                                         */
/* ------------------------------------------------------------------ */

const COPY_LINK_HELP = "Figma에서 가져올 프레임을 클릭해 선택한 뒤 우클릭 → '선택 항목 링크 복사'(Copy link to selection)로 얻은 링크를 넣어 주세요";

/**
 * Figma 링크 → { fileKey, nodeId }
 * - https://www.figma.com/design/<key>/<name>?node-id=12-34
 * - https://www.figma.com/file/<key>/<name>?node-id=12%3A34
 * - 브랜치: https://www.figma.com/design/<key>/branch/<branchKey>/<name>?node-id=... (브랜치 키를 쓴다)
 * - 프로토타입: ?node-id=... 또는 ?starting-point-node-id=...
 */
export function parseFigmaLink(url: string): { fileKey: string; nodeId: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error("Figma 링크 형식이 아닙니다 (https://www.figma.com/… 로 시작하는 주소)");
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) throw new Error("figma.com 링크만 쓸 수 있습니다");
  const m = /^\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,})(?:\/branch\/([A-Za-z0-9]{10,}))?/.exec(u.pathname);
  if (!m) throw new Error(`Figma 디자인 파일 링크가 아닙니다 (…figma.com/design/파일키/… 형태). ${COPY_LINK_HELP}`);
  const fileKey = m[2] ?? m[1];
  const raw = u.searchParams.get("node-id") ?? u.searchParams.get("starting-point-node-id");
  if (!raw) throw new Error(`이 링크에는 가져올 프레임이 지정되어 있지 않습니다 (파일 전체 공유 링크). ${COPY_LINK_HELP}`);
  const nodeId = raw.replace(/-/g, ":");
  if (!/^\d+:\d+$/.test(nodeId)) throw new Error("프레임 id 형식이 올바르지 않습니다");
  if (nodeId.startsWith("0:")) throw new Error(`이 링크는 프레임이 아니라 페이지 전체를 가리킵니다 (node-id=${raw}). ${COPY_LINK_HELP}`);
  return { fileKey, nodeId };
}
