/** 개발·테스트용 가짜 모델 응답 (가상 광고주: 동네 수제 쿠키 가게). 실제 광고주 케이스에는 쓰지 않는다. */
import type { Generator } from "./generator";
import type { BriefModelOutput } from "@/core/brief";
import type { IdeaModelOutput } from "@/core/ideas";

/** 일부러 규칙을 어기는 첫 응답 → 검증 오류 → 재시도에서 고친 응답 */
export function badBrief(): BriefModelOutput {
  return {
    client: { content: "달빛쿠키: 동네에서 매일 아침 직접 굽는 수제 쿠키 가게", estimated: false },
    background: { content: "골목 안쪽이라 인지도가 낮고 단체 주문 문의가 거의 없다.", estimated: false },
    problem: { content: "가게 위치가 눈에 띄지 않기 때문에 단체 주문 문의가 들어오지 않는다.", estimated: false },
    objective: { category: "문의·상담", kpi: "단체 주문 문의 수 (목표 숫자 확인 필요)", estimated: true },
    review: { status: "비대상", reason: "일반 식품(제과)으로 심의 대상 업종이 아님" },
    target: { content: "모두", estimated: false }, // 금지: 모두
    insightCandidates: ["사람들은 동네 빵집을 자주 가지만 실제로는 쿠키 단체 주문처는 잘 모른다", "부모들은 간식 성분을 따지지만 실제로는 확인할 방법이 적다"], // 2개뿐 → 오류
    competition: { content: "역 앞 프랜차이즈 베이커리, 옆 동네 쿠키 공방", estimated: false },
    competitorsNeedCapture: ["옆 동네 쿠키 공방"],
    benefit: { content: "누적 판매량 1만 개의 검증된 맛", estimated: false }, // 지어낸 숫자·근거
    evidence: { status: "있음", quotes: ["버터 100% 사용", "고객 만족도 98%"] }, // 두 번째는 지어냄
    keyMessageCandidates: ["매일 아침 직접 굽는 쿠키, 단체 주문도 됩니다", "최고의 수제 쿠키"], // 금지어 '최고'
    ctaCandidates: ["단체 주문 문의", "메뉴 보기"],
    tone: { content: "따뜻하고 소박한 말투, 아침 햇살 느낌의 베이지·갈색", estimated: true },
    mediaEstimate: "동네 상권이면 인스타그램·페이스북과 네이버 지역 광고 추천",
  };
}

export function goodBrief(): BriefModelOutput {
  const b = badBrief();
  return {
    ...b,
    target: { content: "동네에 사는 30~40대, 모임·행사 간식을 준비하는 사람", estimated: true },
    insightCandidates: [
      "사람들은 행사 간식을 정성 있게 고르고 싶지만 실제로는 가까운 프랜차이즈를 고른다",
      "사람들은 수제 쿠키를 좋아하지만 실제로는 단체 주문이 되는지 모른다",
      "사람들은 동네 가게를 응원하고 싶지만 실제로는 골목 안 가게를 발견하지 못한다",
    ],
    benefit: { content: "그날 아침 직접 구운 쿠키만 판다", estimated: false },
    keyMessageCandidates: ["매일 아침 직접 굽는 쿠키, 단체 주문도 됩니다", "골목 안 쿠키 가게, 행사 간식으로 만나요"],
  };
}

export function goodIdeas(): IdeaModelOutput {
  const base = {
    subCopy: "매일 아침 직접 굽는 수제 쿠키",
    evidenceSource: "",
    requestToClient: "",
    riskNotes: "",
    estimated: false,
  };
  return {
    ideas: [
      {
        ...base,
        title: "행사 준비 고민",
        concept: "행사 간식 고르기 귀찮은 마음에 공감",
        headlines: ["행사 간식, 아직 못 정하셨죠?", "모임 간식 고민 끝"],
        cta: "단체 주문 문의",
        visual: { scene: "회의실 테이블 위 빈 접시와 메모지", composition: "위에서 내려다본 구도", copySpace: "위", mood: "차분한 오후" },
        evidenceStatus: "해당 없음",
      },
      {
        ...base,
        title: "믿을 수 있는 쿠키",
        concept: "재료와 굽는 방식으로 믿음 주기",
        headlines: ["버터 100%, 그날 구운 것만", "아침에 구운 쿠키만 팝니다"],
        cta: "주문 상담",
        visual: { scene: "오븐에서 막 꺼낸 쿠키 트레이와 버터", composition: "45도 근접", copySpace: "아래", mood: "따뜻한 아침빛" },
        evidenceStatus: "있음",
        evidenceSource: "1부 6번: 버터 100% 사용",
      },
      {
        ...base,
        title: "부담 없는 첫 주문",
        concept: "작은 수량부터 편하게 물어보기",
        headlines: ["열 개부터 편하게 물어보세요", "문의만 해도 괜찮아요"],
        cta: "간단 문의하기",
        visual: { scene: "작은 종이 상자에 담긴 쿠키 몇 개와 리본", composition: "정면 중앙", copySpace: "왼쪽", mood: "가볍고 산뜻함" },
        evidenceStatus: "해당 없음",
      },
    ],
  };
}

/** purpose별 응답 순서를 정한 가짜 생성기 */
export function scriptedGenerator(script: Record<string, unknown[]>): Generator & { calls: { purpose: string; user: string }[] } {
  const calls: { purpose: string; user: string }[] = [];
  const gen = (async (req) => {
    calls.push({ purpose: req.purpose, user: req.user });
    const queue = script[req.purpose];
    if (!queue?.length) throw new Error(`no scripted response for ${req.purpose}`);
    const data = queue.length > 1 ? queue.shift() : queue[0];
    return { data: req.schema.parse(data), model: "fake-model", stopReason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
  }) as Generator & { calls: typeof calls };
  gen.calls = calls;
  return gen;
}

export function goodImagePrompt() {
  return {
    promptEn:
      "Warm early-morning light on a rustic wooden workbench, a cooling rack and a small dish of butter, scattered flour, soft shadows, shallow depth of field, cozy bakery mood, beige and brown tones",
    promptKo: "이른 아침 햇살이 드는 나무 작업대, 식힘망과 버터 접시, 흩어진 밀가루, 부드러운 그림자, 따뜻한 베이지·갈색 톤",
    copySpace: "위" as const,
    aspect: "1:1" as const,
  };
}

/** 이미지 검수 응답. textOn 에 적은 파일에는 "AI 글자"가 있다고 답한다 */
export function goodQa(textOn: string[] = []) {
  const files = ["A", "B"].flatMap((v) => ["1080x1080", "1200x628", "320x100"].map((s) => `${v}_${s}.png`));
  return {
    images: files.map((file) => ({
      file,
      generatedTextOrLogo: textOn.includes(file)
        ? { found: true, evidence: "왼쪽 아래 선반의 병 라벨에 알아볼 수 없는 영문 글자" }
        : { found: false, evidence: "배경·소품에 글자나 로고 없음" },
      copyReadable: { ok: true, evidence: "문구가 배경과 잘 구분됨" },
      productMatch: { status: "같음" as const, evidence: "쿠키 모양과 색이 원본과 같음" },
      reviewRisk: { found: false, evidence: "과장·보장 표현 없음" },
    })),
    overall: textOn.length ? "일부 시안 배경에 AI가 만든 글자가 있습니다" : "큰 문제 없음",
  };
}

/** 가짜 모드(npm run dev:fake) 화면 시험용 */
export function devFakeGenerator(): Generator {
  return scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()], qa: [goodQa(["B_1200x628.png"])] });
}
