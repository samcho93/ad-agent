import { describe, expect, it } from "vitest";
import { buildIdeas } from "@/core/ideas";
import { buildBrief } from "@/core/brief";
import { IntakeSchema } from "@/core/intake";
import { bannedHits, factIssues, unsupportedNumbers, unsupportedKoreanQuantities, visualTextHits, reviewIndustryHits } from "@/core/validate";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas } from "@/llm/fake";

import { DEFAULT_SETTINGS } from "@/core/settings";
const settings = DEFAULT_SETTINGS;

describe("검증기", () => {
  it("1부에 없는 숫자를 찾는다", () => {
    expect(unsupportedNumbers("버터 100%, 1만 개 판매", "버터 100% 사용")).toEqual(["1"]);
  });
  it("한글 수량 표현을 찾는다", () => {
    expect(unsupportedKoreanQuantities("열 개부터 편하게 물어보세요", "수제 쿠키")).toEqual(["열 개"]);
    expect(unsupportedKoreanQuantities("세 가지 맛", "초코, 오트밀, 말차 세 가지 맛")).toEqual([]);
  });
  it("실제 출력에서 나온 오탐을 내지 않는다 (2026-11-09 CLI 실행)", () => {
    const corpus = "버터 100% 사용, 방부제를 넣지 않고 그날 구운 것만 판다.";
    // 방향·문서 참조 번호는 숫자가 아니다
    expect(unsupportedNumbers("포근한 분위기를 전한다 (방향 1: 감성)", corpus)).toEqual([]);
    expect(unsupportedNumbers("근거: 1부 6번 '버터 100% 사용', 2안과 다르게", corpus)).toEqual([]);
    // 관용 표현은 수량이 아니다
    expect(unsupportedKoreanQuantities("오시는 한 분 한 분께 한 번 더", corpus)).toEqual([]);
    // 설명 글에서 금지어를 규칙으로 언급하는 것은 위반이 아니다
    const tone = "과장 표현은 쓰지 않는다('최고', '무첨가' 금지).";
    expect(factIssues("tone", tone, corpus, ["최고", "무첨가"], { copy: false })).toEqual([]);
    // 광고 문구에 쓰면 위반이다
    expect(factIssues("cta", "동네 최고 쿠키", corpus, ["최고", "무첨가"]).some((i) => i.severity === "error")).toBe(true);
    // 나이대는 타깃 묘사다 (2026-11-10 브리지 실행에서 나온 오탐)
    expect(unsupportedNumbers("동네에 사는 20~40대, 30대 부모, 65세 이상", corpus)).toEqual([]);
    // 진짜 지어낸 숫자는 여전히 잡는다
    expect(unsupportedNumbers("누적 판매 1만 개 (방향 2)", corpus)).toEqual(["1"]);
  });
  it("금지어를 찾는다", () => {
    expect(bannedHits("동네 최고 쿠키", ["최고", "무첨가"])).toEqual(["최고"]);
  });
  it("이미지 묘사의 글자·로고를 찾되 '없이'는 허용한다", () => {
    expect(visualTextHits("가게 간판이 보이는 골목")).toEqual(["간판"]);
    expect(visualTextHits("글자와 로고 없이 쿠키만, 위쪽에 문구 자리를 비워 둠")).toEqual([]);
    expect(visualTextHits("골목 끝 가게 입구, 간판이나 글자가 보이지 않게 비스듬히")).toEqual([]);
    expect(visualTextHits("포장지에 브랜드 로고가 크게 보이는 정면 컷")).toEqual(["로고"]);
  });
  it("심의 업종 키워드", () => {
    expect(reviewIndustryHits("피부과 시술 상담")).toEqual(["의료"]);
    expect(reviewIndustryHits("수제 쿠키")).toEqual([]);
  });
});

describe("규칙 강제", () => {
  const intake = IntakeSchema.parse(intakeFixture);

  it("심의 키워드가 있으면 모델이 '비대상'이라 해도 '확인 필요'로 올린다", () => {
    const i2 = structuredClone(intake);
    i2.answers["1"].text = "피부과 레이저 시술";
    const b = buildBrief(i2, goodBrief(), settings, "m");
    expect(b.reviewStatus).toBe("확인 필요");
    expect(b.checklist.find((c) => c.id === "review")!.reasons.join()).toContain("심의");
  });

  it("1부 3번 답이 있으면 모델이 목적을 바꾸지 못한다", () => {
    const i2 = structuredClone(intake);
    i2.answers["3"] = { choice: "매출", unknown: false };
    const b = buildBrief(i2, goodBrief(), settings, "m");
    expect(b.objectiveCategory).toBe("매출");
    // 목적은 답에서 왔으므로 추정이 아니다. KPI만 추정이면 KPI에만 표시한다
    expect(b.objectiveEstimated).toBe(false);
    const row = b.rows.find((r) => r.id === "objective")!;
    expect(row.content.startsWith("목적: 매출.")).toBe(true);
    expect(row.content).toContain("(추정)");
    expect(b.issues.some((x) => x.where === "objective")).toBe(true);
  });

  it("'믿을 근거' 방향인데 근거가 없으면 '근거 없음'과 보완 요청을 붙인다", () => {
    const i2 = structuredClone(intake);
    i2.answers["6"] = { text: "", unknown: true };
    const b = buildBrief(i2, { ...goodBrief(), evidence: { status: "근거 없음", quotes: [] } }, settings, "m");
    expect(b.evidenceStatus).toBe("근거 없음");
    const out = goodIdeas();
    out.ideas[1].headlines = ["아침에 구운 쿠키만 팝니다", "그날 구운 것만"];
    const d = buildIdeas(i2, b, out, "m");
    expect(d.ideas[1].evidenceStatus).toBe("근거 없음");
    expect(d.ideas[1].requestToClient).not.toBe("");
  });

  it("아이디어 비주얼에 로고·간판이 있으면 오류", () => {
    const b = buildBrief(intake, goodBrief(), settings, "m");
    const out = goodIdeas();
    out.ideas[0].visual.scene = "가게 간판과 로고가 크게 보이는 골목";
    const d = buildIdeas(intake, b, out, "m");
    expect(d.issues.some((x) => x.where === "idea-1" && x.severity === "error")).toBe(true);
  });

  it("제품형인데 제품 사진이 없으면 사진 요청 메모를 붙인다", () => {
    const i2 = structuredClone(intake);
    i2.answers["10"] = { assets: ["로고 파일"], text: "", unknown: false };
    const b = buildBrief(i2, goodBrief(), settings, "m");
    expect(b.rows.find((r) => r.id === "imagePolicy")!.candidates![0]).toContain("사진 요청");
    const d = buildIdeas(i2, b, goodIdeas(), "m");
    for (const x of d.ideas) expect(x.productPhotoNote).toContain("사진 요청");
  });
});
