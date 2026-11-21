import { describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { FAKE_PROFILE_TEXT, goodBrief, goodPrefill, scriptedGenerator } from "@/llm/fake";
import { buildPrefill, quoteInText, sanitizeProfileText } from "@/core/prefill";
import { prefillFromDescription } from "@/llm/prefillPipeline";
import { IntakeSchema, intakeCorpus, intakeForModel, isAiEstimated, isEstimatedAnswer } from "@/core/intake";
import { buildBrief } from "@/core/brief";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { PrefillModelOutput } from "@/core/prefill";
import { toStrictJsonSchema } from "@/llm/jsonSchema";

describe("사업 설명 → 질문지 초안: 코드 검사", () => {
  it("출력 스키마는 OpenAI strict 형식으로 바뀐다 (모든 object 가 닫혀 있고 모든 속성이 required)", () => {
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.type === "object") {
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort());
      }
      Object.values(o).forEach(walk);
    };
    walk(toStrictJsonSchema(PrefillModelOutput));
  });

  it("연락처(전화번호·이메일)는 모델에 보내기 전에 지운다", () => {
    const t = sanitizeProfileText("문의 010-1234-5678, 02-123-4567, me@example.com 으로 주세요. 01012345678");
    expect(t).not.toMatch(/\d{3,4}[-\s]?\d{4}/);
    expect(t).not.toContain("@");
    expect(t).toContain("[연락처 지움]");
  });

  it("인용은 띄어쓰기를 무시하고 원문에 있어야 한다", () => {
    expect(quoteInText("큰길에서 한 블록", "큰길에서 한블록 들어와")).toBe(true);
    expect(quoteInText("대로변 1층", FAKE_PROFILE_TEXT)).toBe(false);
  });

  it("글에 있는 것은 '사업 설명에서', 추측은 '추정'. 사실 문항의 추측과 지어낸 숫자는 버린다", () => {
    const text = sanitizeProfileText(FAKE_PROFILE_TEXT);
    const r = buildPrefill(goodPrefill(), text);
    expect(r.company).toBe("오후세시커피");
    expect(r.sources["0"]).toBe("text");
    expect(r.q1).toEqual({ text: "골목 안 작은 카페, 직접 볶은 원두 커피와 신메뉴 말차크림라떼", place: "서울 망원동 주택가 골목 안, 빨간 벽돌 건물 1층" });
    expect(r.sources["1"]).toBe("text");
    // 타깃·목적·제품 유무는 추정 허용
    expect(r.q2).toBe("근처에 사는 20~30대 동네 주민");
    expect(r.sources["2"]).toBe("estimate");
    expect(r.q3).toEqual({ choice: "사이트·매장 방문", second: "매출" });
    expect(r.sources["3"]).toBe("estimate");
    expect(r.q9).toBe(false);
    expect(r.sources["9"]).toBe("estimate");
    expect(r.q4).toContain("동네 사람들도 가게를 잘 모름");
    expect(r.sources["4"]).toBe("text");
    // 경쟁 업체는 글에 없으면 넣지 않는다
    expect(r.q5).toBeUndefined();
    // 나은 점에 지어낸 숫자(80%)가 있으면 버린다
    expect(r.q6).toBeUndefined();
    expect(r.notes.join()).toContain("80");
    expect(r.q10).toEqual(["매장·공간 사진", "로고 파일"]);
    expect(r.q11).toEqual({ primary: "인스타그램·페이스북", also: [], other: "" });
    expect(r.sources["11"]).toBe("text");
  });

  it("인용이 틀리면: 추정 허용 문항은 '추정'으로 낮추고, 사실 문항은 비운다", () => {
    const out = goodPrefill();
    out.worry = { value: "주차가 어려움", source: "text", quote: "주차가 어려워요" };
    out.place = { value: "강남역 대로변", source: "text", quote: "강남역 대로변" };
    out.company = { value: "다른이름", source: "estimate", quote: "" };
    const r = buildPrefill(out, FAKE_PROFILE_TEXT);
    expect(r.q4).toBe("주차가 어려움");
    expect(r.sources["4"]).toBe("estimate");
    expect(r.q1?.place).toBeUndefined();
    expect(r.company).toBeUndefined();
    expect(r.notes.some((n) => n.includes("상호"))).toBe(true);
  });

  it("모델에는 연락처를 지운 설명만 보내고, 케이스 기록용 로그를 돌려준다", async () => {
    const gen = scriptedGenerator({ intake_prefill: [goodPrefill()] });
    const run = await prefillFromDescription(gen, FAKE_PROFILE_TEXT);
    expect(gen.calls[0].user).toContain("<사업_설명>");
    expect(gen.calls[0].user).not.toContain("010-1234-5678");
    expect(run.text).not.toContain("010-1234-5678");
    expect(run.log).toMatchObject({ purpose: "intake_prefill", estimated: ["2", "3", "9"] });
    expect(JSON.stringify(run.log)).not.toContain("사업_설명");
    await expect(prefillFromDescription(gen, "짧음")).rejects.toThrow(/조금 더/);
  });
});

/** AI 초안으로 채운 질문지 (2·3번은 사람이 고치지 않은 추정) */
function prefilledIntake() {
  const raw = structuredClone(intakeFixture) as Record<string, any>;
  raw.answers["2"] = { text: "근처에 사는 20~30대 동네 주민", unknown: false };
  raw.answers["3"] = { choice: "사이트·매장 방문", second: null, unknown: false };
  raw.profile = { text: "매일 아침 직접 굽는 쿠키 가게예요. 버터 100% 사용.", model: "m", filledAt: "", sources: { "1": "text", "2": "estimate", "3": "estimate" } };
  return IntakeSchema.parse(raw);
}

describe("미리 채운 질문지가 뒤 단계에 주는 영향", () => {
  it("예전 질문지(사업 설명 없음)는 그대로 읽는다", () => {
    const i = IntakeSchema.parse(intakeFixture);
    expect(i.profile).toBeUndefined();
    expect(isAiEstimated(i, 2)).toBe(false);
  });

  it("추정 답은 모델에 '추정'으로 알리고, 사업 설명 원문을 함께 보낸다", () => {
    const i = prefilledIntake();
    expect(isEstimatedAnswer(i, 2)).toBe(true);
    expect(isEstimatedAnswer(i, 1)).toBe(false);
    const t = intakeForModel(i);
    expect(t).toContain("2번 타깃: 근처에 사는 20~30대 동네 주민 (추정: AI가 사업 설명으로 추측");
    expect(t).toContain("사업주가 직접 쓴 사업 설명 (원문, 연락처는 지움):");
    expect(t).toContain("버터 100% 사용.");
    expect(t).not.toContain("가상 담당자");
  });

  it("근거 검사 자료에는 사업 설명 원문은 넣고, AI가 추측한 답은 넣지 않는다", () => {
    const c = intakeCorpus(prefilledIntake());
    expect(c).toContain("매일 아침 직접 굽는 쿠키 가게예요");
    expect(c).not.toContain("20~30대");
    expect(c).not.toContain("사이트·매장 방문");
  });

  it("브리프: AI 추정 답에 기댄 항목과 목적은 '추정'으로 표시한다", () => {
    const b = buildBrief(prefilledIntake(), goodBrief(), DEFAULT_SETTINGS, "m");
    const row = (id: string) => b.rows.find((r) => r.id === id)!;
    expect(row("target").estimated).toBe(true);
    expect(b.objectiveCategory).toBe("방문·인지");
    expect(b.objectiveEstimated).toBe(true);
    expect(row("objective").content).toContain("추정: AI가 사업 설명으로 추측");
    expect(b.checklist.some((c) => c.id === "objective")).toBe(true);
  });
});
