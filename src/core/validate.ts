/**
 * 절대 규칙을 코드로 검사한다. 프롬프트에만 맡기지 않는다.
 * - 광고주가 주지 않은 숫자·후기·수상 같은 사실이 들어갔는지
 * - 쓰면 안 되는 말이 들어갔는지
 * - 심의 업종 키워드
 */

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  where: string; // 항목 id 또는 아이디어 id
  message: string;
}

const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 숫자 토큰: 1부 답에 없는 숫자는 지어낸 사실일 수 있다 */
/**
 * 문서 안 참조 번호는 사실이 아니므로 숫자 검사에서 뺀다.
 * 예) "1부 6번", "방향 1", "2안", "(방향 3: 우리 가게다운 모습)"
 */
export function stripReferences(text: string): string {
  return text
    .replace(/[12]\s*부(\s*답)?(\s*\d+\s*(,\s*\d+\s*)*번)?/g, " ")
    .replace(/\d+\s*번\s*(질문|답|항목)/g, " ")
    .replace(/방향\s*\d+/g, " ")
    // 나이대("30대", "20~40대", "65세 이상")는 타깃 묘사이지 사실 주장이 아니다
    .replace(/\d+\s*(?:[~∼\-]\s*\d+\s*)?(?:대|세)(?![가-힣]*(?:판매|선택|구매))/g, " ")
    .replace(/\d+\s*안(?=[\s.,):과와은는이가을를의에도]|$)/g, " ");
}

export function unsupportedNumbers(text: string, corpus: string): string[] {
  const corpusDigits = new Set((corpus.match(/\d+(?:[.,]\d+)?/g) ?? []).map((d) => d.replace(/,/g, "")));
  const found = stripReferences(text).match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(found.map((d) => d.replace(/,/g, "")).filter((d) => !corpusDigits.has(d)))];
}

/**
 * 한글 수사 + 단위 ("열 개", "세 가지"): 숫자 검사로 안 잡히는 수량 표현.
 * "한 번", "한 분", "한 일"처럼 관용으로 많이 쓰는 단위(번·분·일)는 넣지 않는다.
 */
const KOREAN_QTY = /(?<![가-힣])(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|서른|마흔|쉰|백|천|만)\s?(개|명|병|박스|상자|봉지|가지|배|년|시간|퍼센트|프로)(?![가-힣]*요일)/g;

export function unsupportedKoreanQuantities(text: string, corpus: string): string[] {
  const c = normalize(corpus);
  const found = text.match(KOREAN_QTY) ?? [];
  return [...new Set(found.filter((q) => !c.includes(normalize(q))))];
}

/** 사실 주장 단어: 1부에 없는데 나오면 지어낸 근거일 수 있다 */
const CLAIM_WORDS = [
  "후기", "리뷰", "수상", "1위", "만족도", "재구매", "판매량", "누적", "인증", "특허", "검증된", "임상", "최초", "유일", "최고", "명이 선택", "연속",
];

export function unsupportedClaims(text: string, corpus: string): string[] {
  const c = normalize(corpus);
  return CLAIM_WORDS.filter((w) => text.includes(w) && !c.includes(normalize(w)));
}

export function bannedHits(text: string, banned: string[]): string[] {
  const t = normalize(text);
  return banned.filter((b) => t.includes(normalize(b)));
}

/** 심의 업종 키워드 (업종별 규정은 시작 전 확인 필요: docs/decisions.md) */
const REVIEW_KEYWORDS: Record<string, string[]> = {
  의료: ["병원", "의원", "클리닉", "치과", "한의원", "피부과", "성형", "시술", "진료", "의료"],
  건강기능식품: ["건강기능식품", "건기식", "영양제", "유산균", "프로바이오틱스", "다이어트 보조", "비타민"],
  금융: ["대출", "보험", "투자", "증권", "카드", "금융", "펀드", "코인", "가상자산", "저축"],
};

export function reviewIndustryHits(corpus: string): string[] {
  const hits: string[] = [];
  for (const [industry, words] of Object.entries(REVIEW_KEYWORDS)) {
    if (words.some((w) => corpus.includes(w))) hits.push(industry);
  }
  return hits;
}

/** "모두", "누구나" 같은 타깃은 금지 (ad-brief) */
export function vagueTarget(text: string): boolean {
  return /(^|\s)(모두|누구나|모든 사람|전 연령|남녀노소)/.test(text);
}

/** 이미지 묘사에 글자·로고가 들어가라고 쓰였는지 (부정문 "없이/없는/넣지"는 허용) */
export function visualTextHits(text: string): string[] {
  const words = ["글자", "문구", "텍스트", "로고", "간판", "워터마크", "레터링", "타이포"];
  const hits: string[] = [];
  for (const w of words) {
    let idx = text.indexOf(w);
    while (idx >= 0) {
      const after = text.slice(idx, idx + w.length + 12);
      const negated = /(없|않|넣지|말고|금지|빼|제외|비워|가려|자리|공간|영역|얹)/.test(after);
      if (!negated) {
        hits.push(w);
        break;
      }
      idx = text.indexOf(w, idx + 1);
    }
  }
  return hits;
}

/** 문자 2-gram 자카드 유사도 (아이디어 겹침 검사) */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const n = normalize(s);
    const set = new Set<string>();
    for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 근거 인용이 1부 6번 답에 실제로 있는지 */
export function quoteSupported(quote: string, source: string): boolean {
  const q = normalize(quote);
  return q.length > 0 && normalize(source).includes(q);
}

/** 한 텍스트에 대한 사실 검사 묶음 */
export function factIssues(where: string, rawText: string, corpus: string, banned: string[], opts?: { allowNumbers?: boolean; copy?: boolean }): Issue[] {
  const issues: Issue[] = [];
  // 광고 문구(copy)가 아닌 설명 글은 "'최고' 금지"처럼 금지어를 규칙으로 언급할 수 있다.
  // 그런 언급은 위반이 아니므로 금지어 검사를 하지 않고, 근거성 표현 검사에서도 금지어를 지운다.
  const isCopy = opts?.copy ?? true;
  let text = rawText;
  if (!isCopy) for (const b of banned) text = text.split(b).join(" ");
  if (!isCopy) banned = [];
  if (!opts?.allowNumbers) {
    const nums = unsupportedNumbers(text, corpus);
    if (nums.length) issues.push({ severity: "error", where, message: `1부 답에 없는 숫자: ${nums.join(", ")}` });
    const qty = unsupportedKoreanQuantities(text, corpus);
    if (qty.length) issues.push({ severity: "warning", where, message: `1부 답에 없는 수량 표현: ${qty.join(", ")} (광고주 확인 필요)` });
  }
  // 근거성 표현 검사는 광고 문구에만 한다. 설명 글은 "후기가 없어 요청한다"처럼 없는 근거를 말하는 경우가 많다.
  const claims = isCopy ? unsupportedClaims(text, corpus) : [];
  if (claims.length) issues.push({ severity: "warning", where, message: `1부 답에 없는 근거성 표현: ${claims.join(", ")} (지어낸 사실인지 확인)` });
  const banHits = bannedHits(text, banned);
  if (banHits.length) issues.push({ severity: "error", where, message: `쓰면 안 되는 말 포함: ${banHits.join(", ")}` });
  return issues;
}
