import { describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodRevision, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief } from "@/llm/pipeline";
import { generateRevisionDraft, openRevision, readRevisionDraft } from "@/llm/revisionPipeline";
import { applySuggestion, buildRevisionDraft, parseSuggestion, type RevisionModelOutput } from "@/core/revision";
import { emptyDelivery, type RevisionRecord } from "@/core/delivery";
import type { ComposeDoc } from "@/core/compose";

const doc = (): ComposeDoc => ({
  version: 1,
  shared: {
    template: "banner-square-v1",
    image: "04_images/s.png",
    product: { file: "04_images/c.png", dx: 0, dy: 0, scale: 1.4 },
    logo: { file: "assets/l.png", corner: "tr", scale: 1 },
    copySpace: "아래",
    textColor: "#ffffff",
    overlay: 0.55,
    sizes: ["1080x1080", "1200x628", "320x100"],
  },
  variants: {
    A: { headline: "버터 100%, 그날 구운 것만", sub: "매일 아침 직접 굽는 수제 쿠키", cta: "단체 주문 문의", buttonBg: "#b4541f", buttonFg: "#ffffff" },
    B: { headline: "아침에 구운 쿠키만 팝니다", sub: "매일 아침 직접 굽는 수제 쿠키", cta: "주문 상담", buttonBg: "#2f5d50", buttonFg: "#ffffff" },
  },
  updatedAt: "2026-11-13T00:00:00.000Z",
  updatedBy: "AE 김",
});
const rev: RevisionRecord = { at: "2026-11-13T01:00:00.000Z", by: "AE 김", round: 1, source: "광고주", kinds: ["글자", "색"], detail: "시안 A 기준. 글자: 헤드라인을 더 짧게 / 색: 버튼을 더 눈에 띄게", type: "수정", counted: true };

describe("광고주 수정 요청 → AI 수정안", () => {
  it("열린 수정 요청은 마지막 시안 발송 뒤에 들어온 것만", () => {
    const d = emptyDelivery();
    expect(openRevision(d)).toBeNull();
    d.proofs.push({ id: "p1", round: 1, createdAt: "2026-11-13T00:30:00.000Z", createdBy: "AE", composeUpdatedAt: "" });
    d.revisions.push(rev);
    expect(openRevision(d)?.detail).toContain("더 짧게");
    d.proofs.push({ id: "p2", round: 2, createdAt: "2026-11-13T02:00:00.000Z", createdBy: "AE", composeUpdatedAt: "" });
    expect(openRevision(d)).toBeNull();
  });

  it("범위 밖·없는 항목 제안은 버리고, 문구 후보는 사실·금지어 검사를 한다", () => {
    const out: RevisionModelOutput = structuredClone(goodRevision());
    out.copyOptions.push({ variant: "B", lead: "", headline: "동네 최고 쿠키 1위", sub: "", cta: "주문", reason: "강조" });
    out.layoutSuggestions.push({ field: "buttonFg", variant: "공통", value: "#000000", reason: "시안 구분 없음" });
    const d = buildRevisionDraft(out, doc(), rev, "버터 100% 사용 매일 아침 직접 굽는 수제 쿠키", ["최고"], "fake-model");
    expect(d.copyOptions).toHaveLength(3);
    expect(d.copyOptions[0].patch.headline).toBe("버터 100%,\n그날 구운 것만");
    expect(d.copyOptions[0].issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(d.copyOptions[2].issues.some((i) => i.severity === "error" && /최고/.test(i.message))).toBe(true);
    expect(d.layout.map((l) => l.field)).toEqual(["buttonBg", "productScale"]);
    expect(d.dropped.join()).toMatch(/그라데이션 세기 1\.5/);
    expect(d.dropped.join()).toMatch(/버튼 글자 색/);
    expect(parseSuggestion({ field: "logoCorner", variant: "공통", value: "bl", reason: "" }, { ...doc(), shared: { ...doc().shared, logo: null } })).toBeNull();
  });

  it("고른 제안만 새 명세에 반영하고 원본은 그대로 둔다", () => {
    const base = doc();
    const next = applySuggestion(base, { field: "buttonBg", variant: "A", value: "#3a8f3a", reason: "" });
    const next2 = applySuggestion(next, { field: "productScale", variant: "공통", value: 0.9, reason: "" });
    expect(next2.variants.A.buttonBg).toBe("#3a8f3a");
    expect(next2.variants.B.buttonBg).toBe("#2f5d50");
    expect(next2.shared.product!.scale).toBe(0.9);
    expect(base.variants.A.buttonBg).toBe("#b4541f");
  });

  it("요청과 지금 시안을 프롬프트에 넣고, 결과를 기록·저장한다", async () => {
    const store = new MemoryStore();
    const svc = new CaseService(store, () => DEFAULT_SETTINGS);
    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], revision: [goodRevision()] });
    await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
    const d = await generateRevisionDraft(svc, meta.id, gen, doc(), rev);
    const call = gen.calls.find((c) => c.purpose === "revision")!;
    expect(call.user).toContain("헤드라인을 더 짧게");
    expect(call.user).toContain('헤드라인 "버터 100%, 그날 구운 것만"');
    expect(call.user).toMatch(/쓰면 안 되는 말: 최고, 무첨가/);
    expect(d.copyOptions.length).toBe(2);
    expect((await readRevisionDraft(svc, meta.id))?.revisionAt).toBe(rev.at);
    expect(await store.read(meta.id, "llm_log.jsonl")).toContain('"purpose":"revision_draft"');
  });
});
