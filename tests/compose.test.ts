import { beforeEach, describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodImagePrompt, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { ImageService } from "@/core/imageService";
import { ComposeService, renderFile } from "@/core/composeService";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief, generateIdeas } from "@/llm/pipeline";
import { SIZES, contrastRatio, fitText, layoutFor, wrapKorean, type Measure } from "@/core/compose";
import { applicableCriteria } from "@/core/images";

/** 글자 하나 = size 픽셀, 띄어쓰기 = size*0.3 (가짜 폭) */
const measure: Measure = (t, size) => [...t].reduce((w, ch) => w + (ch === " " ? size * 0.3 : size), 0);
const png = (n = 8) => new Blob([new Uint8Array(n)], { type: "image/png" });

describe("한글 줄바꿈", () => {
  it("어절 단위로 나눈다", () => {
    const r = wrapKorean("행사 간식 아직 못 정하셨죠", 5 * 10, 10, measure);
    expect(r.lines).toEqual(["행사 간식", "아직 못", "정하셨죠"]);
    expect(r.brokeWord).toBe(false);
  });
  it("한 어절이 한 줄보다 길면 글자 단위로 나누고 표시한다", () => {
    const r = wrapKorean("초코칩오트밀말차쿠키", 4 * 10, 10, measure);
    expect(r.lines).toEqual(["초코칩오", "트밀말차", "쿠키"]);
    expect(r.brokeWord).toBe(true);
  });
  it("직접 넣은 줄바꿈을 지킨다", () => {
    expect(wrapKorean("버터 100%\n그날 구운 것만", 100 * 10, 10, measure).lines).toEqual(["버터 100%", "그날 구운 것만"]);
  });
  it("영역에 맞게 글자를 줄이고, 최소 크기에서도 넘치면 잘림으로 본다", () => {
    const ok = fitText("행사 간식 아직 못 정하셨죠", { w: 200, h: 200 }, { maxLines: 2, start: 40, min: 16 }, measure);
    expect(ok.overflow).toBe(false);
    expect(ok.size).toBeLessThan(40);
    expect(ok.lines.length).toBeLessThanOrEqual(2);
    const bad = fitText("아주 아주 아주 아주 아주 아주 아주 긴 헤드라인 문구가 계속 이어집니다", { w: 100, h: 40 }, { maxLines: 2, start: 30, min: 16 }, measure);
    expect(bad.overflow).toBe(true);
  });
});

describe("배치와 점검", () => {
  it("모든 사이즈·문구 위치에서 영역이 배너 안에 있다", () => {
    for (const size of SIZES) for (const cs of ["위", "아래", "왼쪽", "오른쪽"] as const) {
      const L = layoutFor(size, cs);
      for (const b of [L.text, L.product]) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(L.W);
        expect(b.y + b.h).toBeLessThanOrEqual(L.H);
      }
    }
    expect(layoutFor("320x100", "위").showSub).toBe(false);
  });
  it("명도 대비", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#b4541f", "#ffffff")).toBeGreaterThan(4.5);
    expect(contrastRatio("#ffcc00", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("합성 서비스 (MVP 2단계)", () => {
  let store: MemoryStore;
  let svc: CaseService;
  let compose: ComposeService;

  /** 이미지 확정까지 끝낸 케이스 */
  async function readyCase() {
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
    const asset = await images.addAsset(meta.id, png(), "cookie.png", "product", "AE 김");
    await images.addAsset(meta.id, png(), "logo.png", "logo", "AE 김");
    const scene = await images.addImage(meta.id, png(), { source: "upload", role: "scene", tool: "Figma" }, "AE 김");
    const cut = await images.addImage(meta.id, png(), { source: "cutout", role: "cutout", tool: "누끼", fromAssetId: asset.id }, "AE 김");
    const doc = await images.getDoc(meta.id);
    for (const it of [scene, cut]) {
      await images.updateImage(meta.id, it.id, { commercialUseChecked: true, checks: Object.fromEntries(applicableCriteria(it, doc.policy).map((c) => [c, true])), status: "picked" }, "AE 김");
    }
    await images.complete(meta.id, "AE 김");
    return { id: meta.id, images };
  }

  beforeEach(() => {
    store = new MemoryStore();
    svc = new CaseService(store, () => DEFAULT_SETTINGS);
    compose = new ComposeService(svc);
  });

  it("이미지 확정 전에는 열리지 않는다", async () => {
    const meta = await svc.createCase(intakeFixture);
    await expect(compose.ensureDoc(meta.id, "AE 김")).rejects.toThrow(/이미지를 확정/);
  });

  it("A/B 문구는 아이디어에서 오고, 그림·배치는 같으며, 도구 중립 명세가 함께 저장된다", async () => {
    const { id } = await readyCase();
    const doc = await compose.ensureDoc(id, "AE 김");
    const idea = goodIdeas().ideas[1];
    expect(doc.variants.A.headline).toBe(idea.headlines[0]);
    expect(doc.variants.B.headline).toBe(idea.headlines[1]);
    expect(doc.variants.A.sub).toBe(doc.variants.B.sub);
    expect(doc.shared.product).not.toBeNull();
    expect(doc.shared.logo).not.toBeNull();
    const specA = JSON.parse((await store.read(id, "05_compose/compose_spec_A.json"))!);
    const specB = JSON.parse((await store.read(id, "05_compose/compose_spec_B.json"))!);
    expect(specA.image).toBe(specB.image);
    expect(specA.product).toEqual(specB.product);
    expect(specA.sizes).toEqual(["1080x1080", "1200x628", "320x100"]);
    expect(specA.backend).toBe("canvas");
  });

  it("금지어·빈 문구는 저장을 막고, 정상이면 6장 저장 후 합성 완료가 된다", async () => {
    const { id, images } = await readyCase();
    let doc = await compose.ensureDoc(id, "AE 김");
    doc.variants.B.headline = "동네 최고 쿠키";
    doc = await compose.update(id, doc, "AE 김");
    expect((await compose.copyIssues(id, doc)).some((i) => i.severity === "error" && i.message.includes("최고"))).toBe(true);
    const renders = (["A", "B"] as const).flatMap((v) => SIZES.map((s) => ({ variant: v, size: s, blob: png() })));
    await expect(compose.saveRenders(id, renders, [], "AE 김")).rejects.toThrow(/최고/);

    doc.variants.B.headline = "아침에 구운 쿠키만 팝니다";
    await compose.update(id, doc, "AE 김");
    await expect(compose.saveRenders(id, renders, ["시안 A 320x100: 버튼 문구가 너무 깁니다"], "AE 김")).rejects.toThrow(/너무 깁니다/);
    await compose.saveRenders(id, renders, [], "AE 김");
    expect((await svc.getMeta(id)).status).toBe("compose_done");
    expect(await store.readBlob(id, renderFile("B", "320x100"))).not.toBeNull();
    expect(await svc.readApprovals(id)).toContain("합성 완료 | AE 김");

    // 문구를 고치면 다시 저장하도록 상태가 돌아간다
    doc.variants.A.cta = "주문 문의";
    await compose.update(id, doc, "AE 김");
    expect((await svc.getMeta(id)).status).toBe("images_selected");

    // 이미지를 바꾸면 이미지 확정부터 다시
    await compose.saveRenders(id, renders, [], "AE 김");
    const it = (await images.getDoc(id)).items[0];
    await images.updateImage(id, it.id, { note: "교체 검토" }, "AE 김");
    expect((await svc.getMeta(id)).status).toBe("gate1_approved");
  });
});
