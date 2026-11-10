import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodImagePrompt, goodQa, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { ImageService } from "@/core/imageService";
import { ComposeService } from "@/core/composeService";
import { QaService } from "@/core/qaService";
import { DeliveryService } from "@/core/deliveryService";
import { DEFAULT_SETTINGS, type Settings } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief, generateIdeas } from "@/llm/pipeline";
import { imageQaWith } from "@/llm/qaPipeline";
import { SIZES, sizeOf } from "@/core/compose";
import { applicableCriteria } from "@/core/images";
import { MANUAL_IMAGE_CHECK, REVIEW_HUMAN_CHECK, humanChecklist, pngSize } from "@/core/qa";
import { ProofFileSchema, type ProofAnswer } from "@/core/delivery";
import { createBridgeGenerator } from "@/llm/bridgeGenerator";
import { createOpenAIGenerator } from "@/llm/openaiGenerator";
import { createGeminiGenerator } from "@/llm/geminiGenerator";
import { QaModelOutput } from "@/core/qa";

/** 헤더만 맞는 가짜 PNG (가로·세로를 IHDR 에 적는다) */
function png(w: number, h: number, pad = 64): Blob {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return new Blob([b], { type: "image/png" });
}
const renders = (wrongSize?: string) =>
  (["A", "B"] as const).flatMap((v) =>
    SIZES.map((s) => {
      const { w, h } = sizeOf(s);
      return { variant: v, size: s, blob: s === wrongSize && v === "A" ? png(w + 1, h) : png(w, h) };
    }),
  );

const answer = (proofId: string, caseId: string, over: Partial<ProofAnswer>): ProofAnswer => ({
  format: "ad-agent-proof-answer",
  version: 1,
  proofId,
  caseId,
  answeredAt: new Date().toISOString(),
  decision: "confirm",
  variant: "B",
  requests: [],
  comment: "",
  ...over,
});

describe("검수·게이트 2·납품 (MVP 4단계)", () => {
  let store: MemoryStore;
  let settings: Settings;
  let svc: CaseService;
  let compose: ComposeService;
  let qa: QaService;
  let delivery: DeliveryService;

  /** 합성 완료까지 끝낸 케이스 */
  async function composedCase() {
    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()] });
    await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
    await generateIdeas(svc, meta.id, gen);
    const b = (await svc.getBrief(meta.id))!;
    for (const c of b.checklist) {
      const r = b.rows.find((x) => x.id === c.id)!;
      await svc.decide(meta.id, c.id, r.candidates?.[0] ?? r.content, "AE 김");
    }
    await svc.approveGate1(meta.id, "idea-2", "AE 김");
    const images = new ImageService(svc);
    const asset = await images.addAsset(meta.id, png(800, 800), "cookie.png", "product", "AE 김");
    await images.addAsset(meta.id, png(200, 80), "logo.png", "logo", "AE 김");
    const scene = await images.addImage(meta.id, png(1024, 1024), { source: "upload", role: "scene", tool: "Figma" }, "AE 김");
    const cut = await images.addImage(meta.id, png(600, 600), { source: "cutout", role: "cutout", tool: "누끼", fromAssetId: asset.id }, "AE 김");
    const doc = await images.getDoc(meta.id);
    for (const it of [scene, cut]) {
      await images.updateImage(meta.id, it.id, { commercialUseChecked: true, checks: Object.fromEntries(applicableCriteria(it, doc.policy).map((c) => [c, true])), status: "picked" }, "AE 김");
    }
    await images.complete(meta.id, "AE 김");
    await compose.ensureDoc(meta.id, "AE 김");
    return meta.id;
  }

  async function passGate2(id: string) {
    const q = (await qa.getDoc(id))!;
    for (const c of q.checks.filter((c) => c.severity === "error")) await qa.setOverride(id, c.id, "디자이너 확인: 문제 없음", "디자이너 박");
    for (const h of humanChecklist(q)) await qa.setHuman(id, h, true, "디자이너 박");
    await qa.approveGate2(id, "디자이너 박");
  }

  beforeEach(() => {
    store = new MemoryStore();
    settings = structuredClone(DEFAULT_SETTINGS);
    svc = new CaseService(store, () => settings);
    compose = new ComposeService(svc);
    qa = new QaService(svc);
    delivery = new DeliveryService(svc);
  });

  it("PNG 헤더에서 크기를 읽는다", async () => {
    const b = new Uint8Array(await png(1200, 628).arrayBuffer());
    expect(pngSize(b)).toEqual({ w: 1200, h: 628 });
    expect(pngSize(new Uint8Array(40))).toBeNull();
  });

  it("합성 저장 전에는 검수할 수 없고, 규격이 다르면 규칙 검사가 오류를 낸다", async () => {
    const id = await composedCase();
    await expect(qa.run(id, "디자이너 박")).rejects.toThrow(/합성 PNG를 저장한 뒤/);
    await compose.saveRenders(id, renders("1200x628"), [], "AE 김");
    const r = await qa.run(id, "디자이너 박");
    const errs = r.checks.filter((c) => c.severity === "error");
    expect(errs.map((c) => c.message).join()).toMatch(/1201x628, 규격 1200x628/);
    expect(r.checks.some((c) => c.message.includes("용량 한도: 확인 필요"))).toBe(true);
    expect(r.llm.status).toBe("skipped");
    expect(humanChecklist(r)).toContain(MANUAL_IMAGE_CHECK);
    expect((await svc.getMeta(id)).status).toBe("qa_done");
    expect(await store.read(id, "qa_report.md")).toContain("검수 보고서");

    // 용량 한도를 숫자로 정하면 비교한다
    settings.qa.maxFileKB = 0.01;
    await compose.saveRenders(id, renders(), [], "AE 김");
    const r2 = await qa.run(id, "디자이너 박");
    expect(r2.checks.filter((c) => c.severity === "error")).toHaveLength(0);
    expect(r2.checks.some((c) => c.severity === "warning" && c.message.includes("한도 0.01KB"))).toBe(true);
  });

  it("LLM 이미지 검수: 원본 사진과 시안 6장을 보내고, AI 글자는 오류로, 넘김은 사유가 있어야 한다", async () => {
    const id = await composedCase();
    await compose.saveRenders(id, renders(), [], "AE 김");
    const gen = scriptedGenerator({ qa: [goodQa(["B_1200x628.png"])] });
    const seen: number[] = [];
    const spy = (async (req) => {
      seen.push(req.images?.length ?? 0);
      expect(req.images?.[0].label).toContain("원본 제품 사진");
      expect(req.user).toContain("버튼");
      return gen(req);
    }) as typeof gen;
    const r = await qa.run(id, "디자이너 박", imageQaWith(spy));
    expect(seen).toEqual([7]);
    expect(r.llm.status).toBe("done");
    const err = r.checks.find((c) => c.source === "llm" && c.severity === "error")!;
    expect(err.where).toBe("B_1200x628.png");
    expect(humanChecklist(r)).not.toContain(MANUAL_IMAGE_CHECK);

    let ready = await qa.readiness(id);
    expect(ready.ok).toBe(false);
    expect(ready.blockers.join()).toMatch(/오류 1개/);
    await expect(qa.setOverride(id, err.id, "", "디자이너 박")).resolves.toBeTruthy(); // 빈 사유 = 넘김 아님
    expect((await qa.readiness(id)).blockers.join()).toMatch(/오류 1개/);
    await expect(qa.approveGate2(id, "디자이너 박")).rejects.toThrow(/게이트 2를 통과할 수 없습니다/);

    await passGate2(id);
    expect((await svc.getMeta(id)).status).toBe("gate2_approved");
    expect(await svc.readApprovals(id)).toMatch(/게이트 2 \| 디자이너 박 \| .*오류 1개 사유 적고 넘김/);
    // 게이트 2 뒤에는 합성·이미지가 잠긴다
    const doc = (await compose.getDoc(id))!;
    await expect(compose.update(id, doc, "AE 김")).rejects.toThrow(/게이트 2를 통과한 시안/);
    ready = await qa.readiness(id);
    expect(ready.ok).toBe(true);
  });

  it("이미지 검수 실패(예전 브리지)는 규칙 결과를 남기고 사람 확인으로 돌린다", async () => {
    const id = await composedCase();
    await compose.saveRenders(id, renders(), [], "AE 김");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ structured_output: goodQa(), model: "claude" }), { status: 200 }));
    try {
      const gen = createBridgeGenerator({ url: "http://127.0.0.1:8787", token: "x".repeat(24), model: "claude-opus-5-5", effort: "high" });
      const r = await qa.run(id, "디자이너 박", imageQaWith(gen));
      expect(r.llm.status).toBe("unsupported");
      expect(r.llm.note).toMatch(/0\.2\.0 이상/);
      expect(humanChecklist(r)).toContain(MANUAL_IMAGE_CHECK);
      expect(r.checks.some((c) => c.source === "rule")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("광고주 확인: 수정 요청 → 합성으로 되돌아가 다시 검수 → 2차 확정 → ZIP 납품", async () => {
    const id = await composedCase();
    await compose.saveRenders(id, renders(), [], "AE 김");
    await qa.run(id, "디자이너 박");
    await expect(delivery.makeProof(id, "AE 김")).rejects.toThrow(/게이트 2를 통과한 뒤/);
    await passGate2(id);

    const p1 = ProofFileSchema.parse(JSON.parse(JSON.stringify(await delivery.makeProof(id, "AE 김"))));
    expect(p1.round).toBe(1);
    expect((await delivery.makeProof(id, "AE 김")).proofId).toBe(p1.proofId); // 답 전에 다시 받으면 같은 파일
    expect(p1.variants.A.images["1080x1080"]).toMatch(/^data:image\/png;base64,/);
    expect(JSON.stringify(p1)).not.toContain(intakeFixture.contact.phone); // 연락처 같은 개인정보는 넣지 않는다
    expect(JSON.stringify(p1)).not.toContain(intakeFixture.contact.contactName);

    // 1차: 글자 수정 요청 → 합성 단계로
    await delivery.importAnswer(id, answer(p1.proofId, id, { decision: "revise", variant: "A", requests: [{ kind: "글자", detail: "헤드라인을 더 짧게" }] }), "AE 김");
    expect((await svc.getMeta(id)).status).toBe("images_selected");
    const revMd = (await store.read(id, "revisions.md"))!;
    expect(revMd).toMatch(/1차 \| 광고주 \| 수정 \| 글자 \| 시안 A 기준\. 글자: 헤드라인을 더 짧게 \| 수정 횟수에 포함 \(포함 수정 횟수: 미정\)/);
    await expect(delivery.importAnswer(id, answer(p1.proofId, id, {}), "AE 김")).rejects.toThrow(/이미 기록/);

    // 고쳐서 다시 저장 → 다시 검수 → 게이트 2 → 2차 발송
    const doc = (await compose.getDoc(id))!;
    doc.variants.A.headline = "버터 100%";
    await compose.update(id, doc, "AE 김");
    await compose.saveRenders(id, renders(), [], "AE 김");
    const again = await qa.run(id, "디자이너 박");
    expect(Object.keys(again.human)).toHaveLength(0); // 합성이 바뀌면 사람 확인은 다시
    await passGate2(id);
    const p2 = await delivery.makeProof(id, "AE 김");
    expect(p2.round).toBe(2);
    await expect(delivery.importAnswer(id, answer(p1.proofId, id, {}), "AE 김")).rejects.toThrow(/예전에 보낸 시안/);
    await expect(delivery.importAnswer(id, { ...answer(p2.proofId, id, {}), variant: null }, "AE 김")).rejects.toThrow(/확정한 시안/);
    await expect(delivery.exportZip(id, "AE 김")).rejects.toThrow(/광고주가 시안을 확정/);

    await delivery.importAnswer(id, answer(p2.proofId, id, { variant: "B" }), "AE 김");
    expect((await svc.getMeta(id)).status).toBe("client_selected");
    expect((await delivery.readiness(id)).reviewRequired).toBe(false);

    const zip = await delivery.exportZip(id, "AE 김");
    const files = unzipSync(zip.bytes);
    expect(Object.keys(files).sort()).toEqual(
      ["B_1080x1080.png", "B_1200x628.png", "B_320x100.png", "compose_spec_B.json", "qa_report.md", "approvals.md", "revisions.md", "02_brief.md", "README.txt"].sort(),
    );
    expect(strFromU8(files["approvals.md"])).toMatch(/광고주 확정 .*2차 시안 B 확정/);
    expect(strFromU8(files["approvals.md"])).toMatch(/\| 납품 \| AE 김 \| 시안 B/);
    expect((await svc.getMeta(id)).status).toBe("delivered");
    // 다시 받아도 기록을 또 남기지 않는다
    await delivery.exportZip(id, "AE 김");
    expect((await svc.readApprovals(id)).match(/\| 납품 \|/g)).toHaveLength(1);
  });

  it("콘셉트 변경은 새 시안으로 분류하고 이미지 단계부터 다시 한다", async () => {
    const id = await composedCase();
    await compose.saveRenders(id, renders(), [], "AE 김");
    await qa.run(id, "디자이너 박");
    await passGate2(id);
    const p = await delivery.makeProof(id, "AE 김");
    await delivery.importAnswer(id, answer(p.proofId, id, { decision: "revise", variant: null, requests: [{ kind: "콘셉트 변경", detail: "따뜻한 느낌 말고 시원하게" }] }), "AE 김");
    expect((await svc.getMeta(id)).status).toBe("gate1_approved");
    const d = await delivery.getDoc(id);
    expect(d.revisions[0].type).toBe("새 시안");
    expect(d.revisions[0].counted).toBe(false);
    expect(await store.read(id, "revisions.md")).toContain("새 시안 (수정 횟수 아님, 별도 협의)");
  });

  it("심의 업종: 카피 사전 점검이 게이트 2 필수이고, 완성본 심의 통과 전에는 납품할 수 없다", async () => {
    const id = await composedCase();
    const brief = (await svc.getBrief(id))!;
    brief.reviewStatus = "대상";
    await store.write(id, "02_brief.json", JSON.stringify(brief));
    await compose.saveRenders(id, renders(), [], "AE 김");
    const r = await qa.run(id, "디자이너 박");
    expect(humanChecklist(r)).toContain(REVIEW_HUMAN_CHECK);
    await passGate2(id);
    const p = await delivery.makeProof(id, "AE 김");
    await delivery.importAnswer(id, answer(p.proofId, id, { variant: "A" }), "AE 김");
    const ready = await delivery.readiness(id);
    expect(ready.ok).toBe(false);
    expect(ready.blockers.join()).toMatch(/완성본 심의 통과/);
    await expect(delivery.recordFinalReview(id, { result: "통과", date: "", memo: "" }, "AE 김")).rejects.toThrow(/날짜/);

    // 심의에서 수정 필요 → 합성으로 되돌아가고 포함 여부는 미정
    await delivery.recordFinalReview(id, { result: "수정 필요", date: "2026-11-20", memo: "효과 보장으로 읽힘", kinds: ["글자"] }, "AE 김");
    expect((await svc.getMeta(id)).status).toBe("images_selected");
    expect((await delivery.getDoc(id)).revisions.at(-1)!.counted).toBeNull();

    await compose.saveRenders(id, renders(), [], "AE 김");
    await qa.run(id, "디자이너 박");
    await passGate2(id);
    const p2 = await delivery.makeProof(id, "AE 김");
    await delivery.importAnswer(id, answer(p2.proofId, id, { variant: "A" }), "AE 김");
    await delivery.recordFinalReview(id, { result: "통과", date: "2026-11-27", memo: "" }, "AE 김");
    expect((await delivery.readiness(id)).ok).toBe(true);
    const files = unzipSync((await delivery.exportZip(id, "AE 김")).bytes);
    expect(strFromU8(files["README.txt"])).toContain("완성본 심의: 통과 (2026-11-27)");
  });
});

describe("이미지 입력 요청 형태", () => {
  afterEach(() => vi.unstubAllGlobals());
  const images = [{ label: "파일: A_1080x1080.png", mime: "image/png" as const, base64: "iVBORw0KGgo=" }];

  it("OpenAI: input_image 로 보낸다", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ id: "r", object: "response", created_at: 0, status: "completed", model: "m", output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(goodQa()), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await createOpenAIGenerator({ apiKey: "k", model: "gpt-5-test", effort: "low", maxTokens: 100 })({ purpose: "qa", system: "S", user: "U", schema: QaModelOutput, images });
    const content = (body.input as { content: { type: string; image_url?: string }[] }[])[0].content;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_image", "input_text"]);
    expect(content[1].image_url).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("Gemini: inlineData 로 보낸다", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(goodQa()) }] }, finishReason: "STOP" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await createGeminiGenerator({ apiKey: "k", model: "gemini-3-test", effort: "low", maxTokens: 100 })({ purpose: "qa", system: "S", user: "U", schema: QaModelOutput, images });
    expect(JSON.stringify(body.contents)).toContain('"inlineData":{"mimeType":"image/png","data":"iVBORw0KGgo="}');
  });

  it("브리지: images 를 넘기고, 새 브리지는 본 장수를 알려 준다", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ structured_output: goodQa(), model: "claude", images_seen: 1 }), { status: 200 });
    });
    const res = await createBridgeGenerator({ url: "http://127.0.0.1:8787", token: "t".repeat(24), model: "claude-opus-5-5", effort: "high" })({ purpose: "qa", system: "S", user: "U", schema: QaModelOutput, images });
    expect((body.images as unknown[]).length).toBe(1);
    expect(res.data.images).toHaveLength(6);
  });
});
