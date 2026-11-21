import { z } from "zod/v4";
import { ASSET_OPTIONS, CHANNEL_OPTIONS, OBJECTIVES } from "./intake";
import { unsupportedNumbers } from "./validate";

/**
 * 사업 설명 → 질문지 초안 (스킬 ad-prefill).
 * 모델은 문항마다 값·출처(text/estimate/none)·원문 인용을 낸다. 출처와 지어낸 내용 검사는 여기서 코드가 한다.
 * - text: 인용이 원문에 실제로 있어야 한다. 없으면 추정으로 낮추거나(추정 허용 문항) 버린다.
 * - 사실 문항(상호, 동네, 경쟁 업체, 나은 점, 꼭 넣을 말·금지어, 좋아하는 광고, 가진 자료)은 text 만 받는다 (절대 규칙 1).
 * - 원문에 없는 숫자가 들어간 값은 버린다.
 */

const Source = z.enum(["text", "estimate", "none"]).describe("text = 사업 설명에 있음, estimate = 추측, none = 알 수 없음");
const Quote = z.string().describe("source 가 text 일 때 근거가 되는 사업 설명 원문 구절 (글자 그대로, 짧게). 아니면 빈 문자열");
const str = (d: string) => z.object({ value: z.string().describe(d), source: Source, quote: Quote });

export const PrefillModelOutput = z.object({
  company: str("상호 (사업 설명에 있을 때만)"),
  what: str("무엇을 팔거나 알리는지 한두 문장"),
  place: str("가게가 있는 동네·지역과 가게 모습 (사업 설명에 있을 때만)"),
  target: str("누구에게 (구체적인 사람)"),
  objective: z.object({
    first: z.enum([...OBJECTIVES, ""]).describe("1순위 목적. 모르면 빈 문자열"),
    second: z.enum([...OBJECTIVES, ""]).describe("2순위 목적. 없으면 빈 문자열"),
    source: Source,
    quote: Quote,
  }),
  worry: str("지금 가장 큰 고민"),
  competitors: z.object({
    value: z.array(z.object({ name: z.string(), url: z.string() })).describe("사업 설명에 나온 경쟁 업체만 (최대 3곳)"),
    source: Source,
    quote: Quote,
  }),
  strength: str("경쟁 업체보다 나은 점 (후기·수치는 원문 그대로)"),
  mustSay: str("광고에 꼭 넣을 말"),
  avoidSay: str("쓰면 안 되는 말 (쉼표로 구분)"),
  likes: str("마음에 드는 광고"),
  dislikes: str("싫은 광고"),
  hasProduct: z.object({ value: z.enum(["있음", "없음", ""]).describe("손에 잡히는 제품을 광고에 보여 주는지"), source: Source, quote: Quote }),
  assets: z.object({
    value: z.array(z.enum(ASSET_OPTIONS.filter((a) => a !== "없음") as [string, ...string[]])).describe("가진 자료 (사업 설명에 있을 때만)"),
    source: Source,
    quote: Quote,
  }),
  media: z.object({
    primary: z.enum([...CHANNEL_OPTIONS, ""]).describe("대표 매체 1개. 모르면 빈 문자열"),
    also: z.array(z.enum(CHANNEL_OPTIONS)).describe("함께 광고할 곳"),
    other: z.string().describe("기타 매체 이름 (기타를 골랐을 때)"),
    source: Source,
    quote: Quote,
  }),
});
export type PrefillModelOutput = z.infer<typeof PrefillModelOutput>;

export type PrefillSource = "text" | "estimate";
type Objective = (typeof OBJECTIVES)[number];
type Channel = (typeof CHANNEL_OPTIONS)[number];

/** 코드가 검사한 뒤의 초안. 값이 없는 문항은 넣지 않는다 */
export interface PrefillResult {
  company?: string;
  q1?: { text?: string; place?: string };
  q2?: string;
  q3?: { choice: Objective; second: Objective | null };
  q4?: string;
  q5?: { name: string; url: string }[];
  q6?: string;
  q7?: { must: string; avoid: string };
  q8?: { likes: string; dislikes: string };
  q9?: boolean;
  q10?: string[];
  q11?: { primary: Channel; also: Channel[]; other: string };
  /** 문항 번호 → 출처 ("0"은 상호). 1번은 '무엇' 기준 */
  sources: Record<string, PrefillSource>;
  /** 버리거나 낮춘 것 (화면에 알림) */
  notes: string[];
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 인용이 원문에 있는지 (띄어쓰기 무시) */
export function quoteInText(quote: string, text: string): boolean {
  const q = norm(quote);
  return q.length >= 2 && norm(text).includes(q);
}

/** 사업 설명에 들어 있는 연락처를 지운다 (모델에 보내지 않음, 절대 규칙 8) */
export function sanitizeProfileText(t: string): string {
  return t
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[연락처 지움]")
    .replace(/(\+?82[-\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}/g, "[연락처 지움]")
    .replace(/\b0\d{1,2}[-.\s)]\d{3,4}[-.\s]\d{4}\b/g, "[연락처 지움]")
    .slice(0, 8000);
}

/**
 * 모델 출력 → 질문지 초안. 출처를 검사하고, 사실 문항의 추정과 지어낸 숫자를 버린다.
 */
export function buildPrefill(out: PrefillModelOutput, text: string): PrefillResult {
  const res: PrefillResult = { sources: {}, notes: [] };
  /** 출처 판정. textOnly 문항은 원문 인용이 맞을 때만 */
  const judge = (label: string, src: "text" | "estimate" | "none", quote: string, textOnly: boolean): PrefillSource | null => {
    if (src === "none") return null;
    if (src === "text") {
      if (quoteInText(quote, text)) return "text";
      if (textOnly) {
        res.notes.push(`${label}: 사업 설명에서 근거를 찾지 못해 비워 둠`);
        return null;
      }
      res.notes.push(`${label}: 원문 인용이 맞지 않아 '추정'으로 표시`);
      return "estimate";
    }
    if (textOnly) {
      res.notes.push(`${label}: 사업 설명에 없는 사실이라 비워 둠 (추측하지 않음)`);
      return null;
    }
    return "estimate";
  };
  /** 원문에 없는 숫자가 있으면 버린다 */
  const clean = (label: string, v: string): string | null => {
    const t = v.trim();
    if (!t) return null;
    const bad = unsupportedNumbers(t, text);
    if (bad.length) {
      res.notes.push(`${label}: 사업 설명에 없는 숫자(${bad.join(", ")})가 있어 비워 둠`);
      return null;
    }
    return t;
  };
  const textField = (label: string, f: { value: string; source: "text" | "estimate" | "none"; quote: string }, textOnly: boolean): { v: string; s: PrefillSource } | null => {
    const s = judge(label, f.source, f.quote, textOnly);
    if (!s) return null;
    const v = clean(label, f.value);
    if (!v) return null;
    return { v, s };
  };

  const company = textField("상호", out.company, true);
  if (company) {
    res.company = company.v;
    res.sources["0"] = company.s;
  }
  const what = textField("1번 무엇", out.what, false);
  const place = textField("1번 동네·가게 모습", out.place, true);
  if (what || place) {
    res.q1 = { ...(what ? { text: what.v } : {}), ...(place ? { place: place.v } : {}) };
    if (what) res.sources["1"] = what.s;
  }
  const target = textField("2번 타깃", out.target, false);
  if (target && !/^(모두|누구나|전\s*연령|모든\s*사람)/.test(target.v)) {
    res.q2 = target.v;
    res.sources["2"] = target.s;
  }
  if (out.objective.first) {
    const s = judge("3번 목적", out.objective.source, out.objective.quote, false);
    if (s) {
      const second = out.objective.second && out.objective.second !== out.objective.first ? out.objective.second : null;
      res.q3 = { choice: out.objective.first, second };
      res.sources["3"] = s;
    }
  }
  const worry = textField("4번 고민", out.worry, false);
  if (worry) {
    res.q4 = worry.v;
    res.sources["4"] = worry.s;
  }
  // 경쟁 업체: 이름이 원문에 있는 곳만
  const comps = out.competitors.value
    .map((c) => ({ name: c.name.trim(), url: c.url.trim() }))
    .filter((c) => c.name && quoteInText(c.name, text))
    .map((c) => ({ ...c, url: c.url && text.includes(c.url) ? c.url : "" }))
    .slice(0, 3);
  if (out.competitors.value.length > comps.length) res.notes.push("5번 경쟁 업체: 사업 설명에 이름이 없는 곳은 뺌");
  if (comps.length) {
    res.q5 = comps;
    res.sources["5"] = "text";
  }
  const strength = textField("6번 나은 점", out.strength, true);
  if (strength) {
    res.q6 = strength.v;
    res.sources["6"] = "text";
  }
  const must = textField("7번 꼭 넣을 말", out.mustSay, true);
  const avoid = textField("7번 쓰면 안 되는 말", out.avoidSay, true);
  if (must || avoid) {
    res.q7 = { must: must?.v ?? "", avoid: avoid?.v ?? "" };
    res.sources["7"] = "text";
  }
  const likes = textField("8번 마음에 드는 광고", out.likes, true);
  const dislikes = textField("8번 싫은 광고", out.dislikes, true);
  if (likes || dislikes) {
    res.q8 = { likes: likes?.v ?? "", dislikes: dislikes?.v ?? "" };
    res.sources["8"] = "text";
  }
  if (out.hasProduct.value) {
    const s = judge("9번 제품 유무", out.hasProduct.source, out.hasProduct.quote, false);
    if (s) {
      res.q9 = out.hasProduct.value === "있음";
      res.sources["9"] = s;
    }
  }
  if (out.assets.value.length) {
    const s = judge("10번 가진 자료", out.assets.source, out.assets.quote, true);
    if (s) {
      res.q10 = [...new Set(out.assets.value)];
      res.sources["10"] = "text";
    }
  }
  if (out.media.primary) {
    const s = judge("11번 매체", out.media.source, out.media.quote, false);
    if (s) {
      const primary = out.media.primary;
      res.q11 = { primary, also: [...new Set(out.media.also.filter((c) => c !== primary))], other: out.media.other.trim() };
      res.sources["11"] = s;
    }
  }
  return res;
}
