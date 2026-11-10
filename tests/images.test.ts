import { beforeEach, describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodImagePrompt, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { ImageService } from "@/core/imageService";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief, generateIdeas } from "@/llm/pipeline";
import { generateImagePrompt } from "@/llm/imagePipeline";
import { buildImagePrompt, parseFigmaLink, promptTextHits, routeFromDecision, applicableCriteria } from "@/core/images";
import { assertFileName } from "@/storage/types";

const png = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

let store: MemoryStore;
let svc: CaseService;
let images: ImageService;

/** 게이트 1까지 끝낸 케이스 */
async function approvedCase(imagePolicyChoice = 0) {
  const meta = await svc.createCase(intakeFixture);
  const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()] });
  await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
  await generateIdeas(svc, meta.id, gen);
  const b = (await svc.getBrief(meta.id))!;
  for (const c of b.checklist) {
    const r = b.rows.find((x) => x.id === c.id)!;
    const pick = c.id === "imagePolicy" ? r.candidates![imagePolicyChoice] : r.candidates?.[0] ?? r.content;
    await svc.decide(meta.id, c.id, pick, "AE 김");
  }
  await svc.approveGate1(meta.id, "idea-2", "AE 김");
  return { id: meta.id, gen };
}

beforeEach(() => {
  store = new MemoryStore();
  svc = new CaseService(store, () => DEFAULT_SETTINGS);
  images = new ImageService(svc);
});

describe("이미지 단계 (MVP 3단계)", () => {
  it("게이트 1 전에는 열리지 않는다", async () => {
    const meta = await svc.createCase(intakeFixture);
    await expect(images.addAsset(meta.id, png(), "a.png", "product", "AE 김")).rejects.toThrow(/게이트 1/);
  });

  it("누끼 경로: 제품 사진이 없으면 막고, 올리면 풀린다", async () => {
    const { id } = await approvedCase(0); // 0번 후보 = 누끼
    let doc = await images.refreshPolicy(id);
    expect(doc.policy!.route).toBe("product_cutout");
    expect(doc.policy!.blockers.join()).toContain("제품 사진 파일");
    await images.addAsset(id, png(), "cookie.png", "product", "AE 김");
    doc = await images.getDoc(id);
    expect(doc.policy!.blockers).toEqual([]);
    expect(await store.read(id, "04_images/policy.md")).toContain("누끼");
  });

  it("프롬프트: 글자·로고 금지와 빈 공간, 누끼 경로는 '제품 그리지 않기'가 고정으로 붙는다", async () => {
    const { id, gen } = await approvedCase(0);
    await images.addAsset(id, png(), "cookie.png", "product", "AE 김");
    const p = await generateImagePrompt(svc, images, id, gen);
    expect(p.promptEn).toMatch(/no text, letters/i);
    expect(p.promptEn).toMatch(/empty area at the top/);
    expect(p.promptEn).toMatch(/Do not draw the product itself/);
    expect(p.issues).toEqual([]);
    const log = await images.readLog(id);
    expect(log.some((l) => l.event === "prompt_created")).toBe(true);
  });

  it("이미지는 받는 즉시 저장·기록되고, 확인 없이 고를 수 없으며, 확정하면 승인 기록에 남는다", async () => {
    const { id, gen } = await approvedCase(0);
    const asset = await images.addAsset(id, png(), "cookie.png", "product", "AE 김");
    const prompt = await generateImagePrompt(svc, images, id, gen);
    const scene = await images.addImage(id, png(20), { source: "figma", role: "scene", tool: "Figma (REST 렌더링)", promptId: prompt.id, figma: { fileKey: "abcdefghijk", nodeId: "1:2" } }, "AE 김");
    const cut = await images.addImage(id, png(30), { source: "cutout", role: "cutout", tool: "브라우저 누끼", fromAssetId: asset.id }, "AE 김");

    expect(await store.readBlob(id, scene.file)).not.toBeNull();
    const saved = (await images.readLog(id)).filter((l) => l.event === "image_saved");
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ tool: "Figma (REST 렌더링)", prompt: { id: prompt.id } });

    await expect(images.updateImage(id, scene.id, { status: "picked" }, "AE 김")).rejects.toThrow(/상업 이용/);
    const doc = await images.getDoc(id);
    const sceneChecks = Object.fromEntries(applicableCriteria(scene, doc.policy).map((c) => [c, true]));
    const cutChecks = Object.fromEntries(applicableCriteria(cut, doc.policy).map((c) => [c, true]));
    expect(Object.keys(cutChecks)).toEqual([expect.stringContaining("누끼 결과")]);
    await images.updateImage(id, scene.id, { commercialUseChecked: true, checks: sceneChecks, status: "picked" }, "AE 김");
    expect((await images.readiness(id)).blockers.join()).toContain("제품 누끼");
    await images.updateImage(id, cut.id, { commercialUseChecked: true, checks: cutChecks, status: "picked" }, "AE 김");

    expect((await images.readiness(id)).ok).toBe(true);
    await images.complete(id, "AE 김");
    expect((await svc.getMeta(id)).status).toBe("images_selected");
    expect(await svc.readApprovals(id)).toContain("이미지 확정 | AE 김");
    // 확정 뒤에도 브리프는 잠겨 있다
    await expect(svc.decide(id, "cta", "x", "AE 김")).rejects.toThrow(/게이트 1/);
    // 이미지를 바꾸면 확정이 풀린다
    await images.updateImage(id, scene.id, { note: "색 조금 밝게" }, "AE 김");
    expect((await svc.getMeta(id)).status).toBe("gate1_approved");
  });

  it("사진 없음 경로는 프롬프트를 만들지 않는다", async () => {
    const meta = await svc.createCase({ ...intakeFixture, answers: { ...intakeFixture.answers, "10": { assets: ["로고 파일"], text: "", unknown: false } } });
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()] });
    await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
    await generateIdeas(svc, meta.id, gen);
    const b = (await svc.getBrief(meta.id))!;
    for (const c of b.checklist) {
      const r = b.rows.find((x) => x.id === c.id)!;
      await svc.decide(meta.id, c.id, r.candidates?.[0] ?? r.content, "AE 김");
    }
    await svc.approveGate1(meta.id, "idea-1", "AE 김");
    const doc = await images.refreshPolicy(meta.id);
    expect(doc.policy!.route).toBe("product_need_photo");
    await expect(generateImagePrompt(svc, images, meta.id, gen)).rejects.toThrow(/사진/);
  });

  it("이미지 파일은 케이스 내보내기·가져오기로 함께 옮겨진다", async () => {
    const { id } = await approvedCase(0);
    await images.addAsset(id, png(64), "cookie.png", "product", "AE 김");
    const bundle = JSON.parse(JSON.stringify(await svc.exportCase(id)));
    const other = new CaseService(new MemoryStore(), () => DEFAULT_SETTINGS);
    const m = await other.importCase(bundle);
    const doc = await new ImageService(other).getDoc(m.id);
    const blob = await other.store.readBlob(m.id, doc.assets[0].file);
    expect(blob?.size).toBe(64);
  });
});

describe("이미지 규칙 검사", () => {
  it("경로 판정", () => {
    expect(routeFromDecision("제품형, 사진 있음: 원본에서 제품을 오려(누끼)", true)).toBe("product_cutout");
    expect(routeFromDecision("제품형, 원본 기반 재생성", true)).toBe("product_regenerate");
    expect(routeFromDecision("제품형, 사진 없음: 광고주에게 제품 사진 요청", true)).toBe("product_need_photo");
    expect(routeFromDecision("무형: 광고주의 실제 매장·공간 사진 사용", false)).toBe("intangible_photo");
    expect(routeFromDecision("무형: 공간·사람·상황·상징 이미지를 AI로 생성", false)).toBe("intangible_ai");
  });

  it("프롬프트 속 글자·로고 묘사를 찾되 부정문은 허용", () => {
    expect(promptTextHits("A bakery storefront with a neon sign and the shop logo")).toEqual(["sign", "logo"]);
    expect(promptTextHits("Cozy table, no text or logos, empty space for text at the top")).toEqual([]);
  });

  it("누끼 경로에서 제품을 그리라는 프롬프트는 오류", () => {
    const idea = goodIdeas().ideas[0] as never;
    const policy = { route: "product_cutout", medical: false } as never;
    const p = buildImagePrompt({ ...goodImagePrompt(), promptEn: "Close-up of freshly baked cookies on a plate" }, idea, policy, "m", "p1");
    expect(p.issues.some((i) => i.message.includes("제품을 그리라고"))).toBe(true);
  });

  it("Figma 링크 읽기", () => {
    expect(parseFigmaLink("https://www.figma.com/design/AbCdEfGhIjKl12/Banner?node-id=12-34&t=x")).toEqual({ fileKey: "AbCdEfGhIjKl12", nodeId: "12:34" });
    expect(() => parseFigmaLink("https://www.figma.com/design/AbCdEfGhIjKl12/Banner")).toThrow(/프레임 링크/);
    expect(() => parseFigmaLink("https://evil.example/design/AbCdEfGhIjKl12/x?node-id=1-2")).toThrow(/figma.com/);
  });

  it("케이스 안 파일 경로는 정해진 하위 폴더 한 단계만", () => {
    expect(() => assertFileName("04_images/a.png")).not.toThrow();
    expect(() => assertFileName("../a.png")).toThrow();
    expect(() => assertFileName("04_images/../../a.png")).toThrow();
    expect(() => assertFileName("other/a.png")).toThrow();
  });
});

describe("Figma 한도 안내", () => {
  it("월간 한도(긴 Retry-After)면 며칠 뒤와 붙여넣기·직접 올리기를 안내한다", async () => {
    const { describeFigmaRateLimit } = await import("@/integrations/figma");
    const h = new Headers({ "retry-after": String(5 * 86400), "x-figma-plan-tier": "starter", "x-figma-rate-limit-type": "low", "x-figma-upgrade-link": "https://www.figma.com/pricing" });
    const msg = describeFigmaRateLimit(h);
    expect(msg).toContain("약 5일");
    expect(msg).toContain("플랜: starter");
    expect(msg).toContain("Ctrl+Shift+C");
    expect(msg).toContain("직접 올리기");
    expect(msg).toContain("https://www.figma.com/pricing");
  });

  it("짧은 한도면 잠깐 기다리라고 한다", async () => {
    const { describeFigmaRateLimit } = await import("@/integrations/figma");
    expect(describeFigmaRateLimit(new Headers({ "retry-after": "30" }))).toContain("30초 뒤에 다시 시도");
  });

  it("가져오기에서 429를 받으면 그 안내로 실패한다", async () => {
    const { fetchFigmaFramePng } = await import("@/integrations/figma");
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429, headers: { "retry-after": "2592000" } }));
    try {
      await expect(fetchFigmaFramePng("tok", "https://www.figma.com/design/AbCdEfGhIjKl12/B?node-id=1-2")).rejects.toThrow(/약 30일/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
