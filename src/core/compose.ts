import type { BriefDoc } from "./brief";
import { effectiveValue } from "./brief";
import type { Idea } from "./ideas";
import type { ImagesDoc } from "./images";
import { factIssues, type Issue } from "./validate";

/* ------------------------------------------------------------------ */
/* 1. 합성 명세                                                          */
/* ------------------------------------------------------------------ */

export const SIZES = ["1080x1080", "1200x628", "320x100"] as const;
export type SizeKey = (typeof SIZES)[number];
export const SIZE_LABEL: Record<SizeKey, string> = { "1080x1080": "정사각 1080", "1200x628": "가로 1200x628", "320x100": "띠 배너 320x100" };
export const sizeOf = (k: SizeKey) => {
  const [w, h] = k.split("x").map(Number);
  return { w, h };
};

export type CopySpace = "위" | "아래" | "왼쪽" | "오른쪽";
export type Corner = "tl" | "tr" | "bl" | "br";
export type Variant = "A" | "B";

/** A/B 가 함께 쓰는 그림과 배치 (시안 A/B는 이것이 같아야 한다) */
export interface SharedLayout {
  template: "banner-square-v1";
  image: string; // 배경 (04_images/...)
  product: { file: string; dx: number; dy: number; scale: number } | null; // 누끼: 영역 중심 기준 이동(-0.5~0.5), 크기 배율
  logo: { file: string; corner: Corner; scale: number } | null;
  copySpace: CopySpace;
  textColor: "#ffffff" | "#1f1d1a";
  overlay: number; // 그라데이션 세기 0~1 (문구 쪽에 깔림)
  sizes: SizeKey[];
}

/** A/B 마다 다른 것: 메시지, 버튼 문구, 버튼 색 */
export interface VariantCopy {
  headline: string;
  sub: string;
  cta: string;
  buttonBg: string;
  buttonFg: string;
}

export interface ComposeDoc {
  version: 1;
  shared: SharedLayout;
  variants: Record<Variant, VariantCopy>;
  updatedAt: string;
  updatedBy: string;
}

/** docs/compose_spec.example.json 형식 (백엔드 어댑터가 읽는 도구 중립 명세) */
export function toComposeSpec(caseId: string, doc: ComposeDoc, v: Variant) {
  const c = doc.variants[v];
  return {
    case: caseId,
    variant: v,
    backend: "canvas",
    template: doc.shared.template,
    texts: { headline: c.headline, sub: c.sub, cta: c.cta },
    button: { bg: c.buttonBg, fg: c.buttonFg },
    textColor: doc.shared.textColor,
    image: doc.shared.image,
    product: doc.shared.product,
    logo: doc.shared.logo,
    copySpace: doc.shared.copySpace,
    overlay: { side: doc.shared.copySpace, strength: doc.shared.overlay },
    sizes: doc.shared.sizes,
    export: ["png"],
    font: "Pretendard (SIL OFL 1.1)",
  };
}

/** 고른 아이디어와 이미지로 첫 명세를 만든다 (A/B 문구는 아이디어에서) */
export function defaultComposeDoc(idea: Idea, brief: BriefDoc, images: ImagesDoc, by: string): ComposeDoc {
  const picked = images.items.filter((i) => i.status === "picked");
  const scene = picked.find((i) => i.role === "scene");
  if (!scene) throw new Error("고른 배경·장면 이미지가 없습니다");
  const cutout = picked.find((i) => i.role === "cutout");
  const logo = images.assets.find((a) => a.kind === "logo");
  const cta = (brief.decisions.cta?.value ?? "").trim();
  const copySpace = (["위", "아래", "왼쪽", "오른쪽"] as const).find((s) => s === idea.visual.copySpace) ?? "위";
  return {
    version: 1,
    shared: {
      template: "banner-square-v1",
      image: scene.file,
      product: cutout ? { file: cutout.file, dx: 0, dy: 0, scale: 1 } : null,
      logo: logo ? { file: logo.file, corner: "tr", scale: 1 } : null,
      copySpace,
      textColor: "#ffffff",
      overlay: 0.55,
      sizes: [...SIZES],
    },
    variants: {
      A: { headline: idea.headlines[0] ?? "", sub: idea.subCopy, cta: cta || idea.cta, buttonBg: "#b4541f", buttonFg: "#ffffff" },
      B: { headline: idea.headlines[1] ?? idea.headlines[0] ?? "", sub: idea.subCopy, cta: idea.cta || cta, buttonBg: "#2f5d50", buttonFg: "#ffffff" },
    },
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
}

/* ------------------------------------------------------------------ */
/* 2. 템플릿 배치 (banner-square-v1)                                       */
/* ------------------------------------------------------------------ */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  W: number;
  H: number;
  text: Box; // 헤드라인·서브·버튼이 들어가는 영역
  product: Box; // 누끼 제품이 놓일 영역
  showSub: boolean;
  buttonInline: boolean; // 띠 배너: 버튼을 문구 옆에
  headline: { maxLines: number; start: number; min: number };
  sub: { maxLines: number; start: number; min: number };
  cta: { size: number; padX: number; padY: number };
  logo: { h: number; margin: number };
  /** 그라데이션: 어느 쪽에서 시작하는지 */
  overlaySide: CopySpace;
}

/** 사이즈와 빈 공간 방향에 맞춘 배치. 모든 값은 픽셀 */
export function layoutFor(size: SizeKey, copySpace: CopySpace): Layout {
  const { w: W, h: H } = sizeOf(size);
  const m = Math.round(Math.min(W, H) * 0.06);

  if (size === "320x100") {
    // 띠 배너: 왼쪽 문구 한 줄 + 오른쪽 버튼, 서브카피 생략
    return {
      W, H,
      text: { x: 10, y: 8, w: Math.round(W * 0.6), h: H - 16 },
      product: { x: 0, y: 0, w: 0, h: 0 }, // 너무 작아 제품은 얹지 않는다

      showSub: false,
      buttonInline: true,
      headline: { maxLines: 2, start: 17, min: 11 },
      sub: { maxLines: 0, start: 0, min: 0 },
      cta: { size: 12, padX: 9, padY: 6 },
      logo: { h: 0, margin: 0 },
      overlaySide: "왼쪽",
    };
  }

  if (size === "1200x628") {
    // 가로형: 문구는 왼쪽 또는 오른쪽 절반
    const right = copySpace === "오른쪽";
    const tw = Math.round(W * 0.46);
    return {
      W, H,
      text: { x: right ? W - m - tw : m, y: m * 2, w: tw, h: H - m * 4 },
      product: { x: right ? m : W - m - Math.round(W * 0.44), y: m, w: Math.round(W * 0.44), h: H - m * 2 },
      showSub: true,
      buttonInline: false,
      headline: { maxLines: 3, start: 62, min: 34 },
      sub: { maxLines: 3, start: 30, min: 20 },
      cta: { size: 26, padX: 30, padY: 16 },
      logo: { h: 44, margin: m },
      overlaySide: right ? "오른쪽" : "왼쪽",
    };
  }

  // 정사각 1080
  const tb = { x: m, y: m * 2, w: W - m * 2, h: Math.round(H * 0.38) };
  const pb = { x: m, y: Math.round(H * 0.42), w: W - m * 2, h: Math.round(H * 0.52) };
  let text = tb;
  let product = pb;
  if (copySpace === "아래") {
    text = { x: m, y: Math.round(H * 0.56), w: W - m * 2, h: Math.round(H * 0.38) };
    product = { x: m, y: m, w: W - m * 2, h: Math.round(H * 0.52) };
  } else if (copySpace === "왼쪽" || copySpace === "오른쪽") {
    const half = Math.round((W - m * 3) / 2);
    const left = { x: m, y: m * 2, w: half, h: H - m * 4 };
    const right = { x: m * 2 + half, y: m, w: half, h: H - m * 2 };
    text = copySpace === "왼쪽" ? left : { ...left, x: m * 2 + half };
    product = copySpace === "왼쪽" ? right : { ...right, x: m };
  }
  return {
    W, H, text, product,
    showSub: true,
    buttonInline: false,
    headline: { maxLines: 3, start: 76, min: 40 },
    sub: { maxLines: 3, start: 36, min: 24 },
    cta: { size: 32, padX: 36, padY: 20 },
    logo: { h: 64, margin: m },
    overlaySide: copySpace,
  };
}

/* ------------------------------------------------------------------ */
/* 3. 한글 줄바꿈과 크기 맞추기                                           */
/* ------------------------------------------------------------------ */

export type Measure = (text: string, size: number) => number;

export interface Wrapped {
  lines: string[];
  /** 한 어절이 한 줄보다 길어 글자 단위로 나눴는지 (가독성 경고) */
  brokeWord: boolean;
}

/**
 * 어절(띄어쓰기) 단위로 줄을 나눈다. 한 어절이 한 줄보다 길면 글자 단위로 나눈다.
 * 직접 넣은 줄바꿈(엔터)은 그대로 지킨다.
 */
export function wrapKorean(text: string, maxWidth: number, size: number, measure: Measure): Wrapped {
  const lines: string[] = [];
  let brokeWord = false;
  for (const para of text.split(/\r?\n/)) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let cur = "";
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (measure(next, size) <= maxWidth) {
        cur = next;
        continue;
      }
      if (cur) lines.push(cur);
      if (measure(word, size) <= maxWidth) {
        cur = word;
        continue;
      }
      brokeWord = true;
      let piece = "";
      for (const ch of [...word]) {
        if (piece && measure(piece + ch, size) > maxWidth) {
          lines.push(piece);
          piece = ch;
        } else piece += ch;
      }
      cur = piece;
    }
    if (cur || words.length === 0) lines.push(cur);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return { lines, brokeWord };
}

export interface Fit {
  size: number;
  lines: string[];
  overflow: boolean;
  brokeWord: boolean;
}

/**
 * 줄 수·높이에 맞고 어절이 잘리지 않을 때까지 글자 크기를 줄인다.
 * 최소 크기에서도 넘치면 overflow (문구 잘림).
 */
export function fitText(text: string, box: { w: number; h: number }, opt: { maxLines: number; start: number; min: number; lineHeight?: number }, measure: Measure): Fit {
  const lh = opt.lineHeight ?? 1.25;
  const step = Math.max(1, Math.round(opt.start * 0.04));
  const fits = (w: Wrapped, size: number) => w.lines.length <= opt.maxLines && w.lines.length * size * lh <= box.h;
  for (let size = opt.start; size >= opt.min; size -= step) {
    const w = wrapKorean(text, box.w, size, measure);
    if (fits(w, size) && !w.brokeWord) return { size, lines: w.lines, overflow: false, brokeWord: false };
  }
  const w = wrapKorean(text, box.w, opt.min, measure);
  return { size: opt.min, lines: w.lines, overflow: !fits(w, opt.min), brokeWord: w.brokeWord };
}

/* ------------------------------------------------------------------ */
/* 4. 점검                                                              */
/* ------------------------------------------------------------------ */

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG 명도 대비 (1~21) */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

/** 문구 자체 점검: 금지어, 지어낸 숫자·근거, 버튼 대비, A/B 차이 */
export function copyIssues(doc: ComposeDoc, corpus: string, banned: string[]): Issue[] {
  const issues: Issue[] = [];
  for (const v of ["A", "B"] as const) {
    const c = doc.variants[v];
    issues.push(...factIssues(`시안 ${v}`, [c.headline, c.sub, c.cta].join("\n"), corpus, banned));
    if (!c.headline.trim()) issues.push({ severity: "error", where: `시안 ${v}`, message: "헤드라인이 비어 있습니다" });
    if (!c.cta.trim()) issues.push({ severity: "error", where: `시안 ${v}`, message: "버튼 문구가 비어 있습니다" });
    const cr = contrastRatio(c.buttonBg, c.buttonFg);
    if (cr < 4.5) issues.push({ severity: "warning", where: `시안 ${v}`, message: `버튼 글자와 배경의 명도 대비가 낮습니다 (${cr}:1, 권장 4.5:1 이상)` });
  }
  const a = doc.variants.A;
  const b = doc.variants.B;
  if (a.headline === b.headline && a.cta === b.cta && a.buttonBg === b.buttonBg) {
    issues.push({ severity: "warning", where: "시안 A/B", message: "A와 B의 문구·버튼이 같습니다. 메시지·버튼 문구·버튼 색 중 하나 이상을 다르게 하세요" });
  }
  return issues;
}

/** 브리프에서 확정한 핵심 메시지 (화면 안내용) */
export const confirmedKeyMessage = (brief: BriefDoc) => effectiveValue(brief, "keyMessage");
