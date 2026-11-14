import { beforeEach, describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodImagePrompt, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { ImageService } from "@/core/imageService";
import { DEFAULT_SETTINGS, mergeSettings } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief, generateIdeas } from "@/llm/pipeline";
import { generateImagePrompt } from "@/llm/imagePipeline";
import {
  ImageGenError,
  createImageGenerator,
  geminiAspect,
  imageToolName,
  isGeminiImageModel,
  pickImage,
  type ImageGenRequest,
  type ImageGenerator,
} from "@/integrations/geminiImage";

const png = (bytes = 10, fill = 0) => new Blob([new Uint8Array(bytes).fill(fill)], { type: "image/png" });

let store: MemoryStore;
let svc: CaseService;
let images: ImageService;

async function approvedCase() {
  const meta = await svc.createCase(intakeFixture);
  const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()] });
  await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
  await generateIdeas(svc, meta.id, gen);
  const b = (await svc.getBrief(meta.id))!;
  for (const c of b.checklist) {
    const r = b.rows.find((x) => x.id === c.id)!;
    await svc.decide(meta.id, c.id, c.id === "imagePolicy" ? r.candidates![0] : r.candidates?.[0] ?? r.content, "AE 김");
  }
  await svc.approveGate1(meta.id, "idea-2", "AE 김");
  return { id: meta.id, gen };
}

/** 요청을 기록하는 가짜 이미지 생성기 */
function recordingGen(): ImageGenerator & { calls: ImageGenRequest[] } {
  const calls: ImageGenRequest[] = [];
  const g = (async (req: ImageGenRequest) => {
    calls.push(req);
    return { blob: png(50, calls.length), model: "gemini-test-image", note: calls.length === 1 ? "배경입니다" : undefined };
  }) as ImageGenerator & { calls: ImageGenRequest[] };
  g.calls = calls;
  return g;
}

beforeEach(() => {
  store = new MemoryStore();
  svc = new CaseService(store, () => DEFAULT_SETTINGS);
  images = new ImageService(svc);
});

describe("Gemini 이미지 생성: 요청·응답 처리", () => {
  it("비율: 1.91:1 은 16:9 로, 모르는 값은 1:1 로", () => {
    expect(geminiAspect("1:1")).toBe("1:1");
    expect(geminiAspect("16:9")).toBe("16:9");
    expect(geminiAspect("1.91:1")).toBe("16:9");
    expect(geminiAspect("이상한값")).toBe("1:1");
  });

  it("모델 목록에서는 Gemini 이미지 모델만 고른다", () => {
    const ids = ["gemini-2.5-flash", "gemini-2.5-flash-image", "gemini-3-pro-image-preview", "imagen-4.0-generate-001", "gemma-3-27b"];
    expect(ids.filter(isGeminiImageModel)).toEqual(["gemini-2.5-flash-image", "gemini-3-pro-image-preview"]);
  });

  it("응답에서 이미지를 꺼내고, 생각(thought) 부분은 건너뛴다", () => {
    const out = pickImage({
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              { thought: true, inlineData: { mimeType: "image/png", data: "VEhPVUdIVA==" } },
              { text: "배경만 만들었습니다" },
              { inlineData: { mimeType: "image/png", data: "QUJD" } },
            ],
          },
        },
      ],
    });
    expect(out).toEqual({ mime: "image/png", base64: "QUJD", note: "배경만 만들었습니다" });
  });

  it("거절·이미지 없음은 쉬운 말로 알린다", () => {
    expect(() => pickImage({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(/거절.*SAFETY/);
    expect(() => pickImage({ candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [{ text: "만들 수 없습니다" }] } }] })).toThrow(
      /이미지를 받지 못했습니다 \(IMAGE_SAFETY\).*만들 수 없습니다/,
    );
  });

  it("설정: 키·모델이 없으면 막고, 가짜 모델 모드는 가짜 생성기를 쓴다", () => {
    const s = mergeSettings({});
    expect(s.imageGen.model).toBe("");
    expect(() => createImageGenerator({ ...s, imageGen: { model: "gemini-x-image" } }, {})).toThrow(ImageGenError);
    expect(() => createImageGenerator(s, { geminiApiKey: "AIza-test" })).toThrow(/이미지 모델을 고르세요/);
    expect(typeof createImageGenerator({ ...s, llm: { ...s.llm, provider: "fake" } }, {})).toBe("function");
    expect(imageToolName("gemini-x-image")).toContain("gemini-x-image");
  });
});

describe("Gemini 이미지 생성: 케이스에 저장·기록", () => {
  it("프롬프트만 보내 여러 장을 만들고, 한 장씩 바로 저장·기록한다", async () => {
    const { id, gen } = await approvedCase();
    await images.addAsset(id, png(), "cookie.png", "product", "AE 김");
    const prompt = await generateImagePrompt(svc, images, id, gen);
    const g = recordingGen();
    const r = await images.generateImages(id, g, { promptId: prompt.id, count: 2, method: "prompt", toolName: imageToolName }, "AE 김");

    expect(g.calls).toHaveLength(2);
    expect(g.calls[0].prompt).toBe(prompt.promptEn); // 글자·로고 금지와 빈 공간 지시가 붙은 프롬프트 그대로
    expect(g.calls[0].prompt).toMatch(/no text, letters/i);
    expect(g.calls[0].references).toEqual([]); // 참조를 고르지 않으면 제품 사진을 보내지 않는다
    expect(r.items).toHaveLength(2);
    expect(r.notes).toEqual(["배경입니다"]);
    for (const it of r.items) {
      expect(it).toMatchObject({ source: "gemini", role: "scene", promptId: prompt.id, method: "prompt", status: "candidate", commercialUseChecked: false });
      expect(it.tool).toContain("gemini-test-image");
      expect(await store.readBlob(id, it.file)).not.toBeNull();
    }
    const saved = (await images.readLog(id)).filter((l) => l.event === "image_saved");
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ source: "gemini", prompt: { id: prompt.id } });
    expect(JSON.stringify(await images.readLog(id))).not.toMatch(/AIza|base64/);
  });

  it("'제품 사진을 참조로' 를 고르면 고른 제품 사진만 보내고 기록한다", async () => {
    const { id, gen } = await approvedCase();
    const a1 = await images.addAsset(id, png(8, 7), "cookie.png", "product", "AE 김");
    await images.addAsset(id, png(8, 9), "logo.png", "logo", "AE 김");
    const prompt = await generateImagePrompt(svc, images, id, gen);
    const g = recordingGen();
    const r = await images.generateImages(id, g, { promptId: prompt.id, count: 1, method: "product_reference", referenceAssetIds: [a1.id], toolName: imageToolName }, "AE 김");
    expect(g.calls[0].references).toHaveLength(1);
    expect(g.calls[0].references[0].mime).toBe("image/png");
    expect(atob(g.calls[0].references[0].base64)).toBe(String.fromCharCode(7).repeat(8));
    expect(r.items[0]).toMatchObject({ method: "product_reference", referenceAssetIds: [a1.id] });
  });

  it("이름 없음·없는 프롬프트·참조 사진 없음·로고를 참조로 고름은 막는다", async () => {
    const { id, gen } = await approvedCase();
    const logo = await images.addAsset(id, png(), "logo.png", "logo", "AE 김");
    const prompt = await generateImagePrompt(svc, images, id, gen);
    const g = recordingGen();
    const base = { promptId: prompt.id, count: 1, method: "prompt" as const, toolName: imageToolName };
    await expect(images.generateImages(id, g, base, " ")).rejects.toThrow(/작업자 이름/);
    await expect(images.generateImages(id, g, { ...base, promptId: "nope" }, "AE 김")).rejects.toThrow(/프롬프트를 고르세요/);
    await expect(images.generateImages(id, g, { ...base, method: "product_reference", referenceAssetIds: [] }, "AE 김")).rejects.toThrow(/제품 사진을 고르세요/);
    await expect(images.generateImages(id, g, { ...base, method: "product_reference", referenceAssetIds: [logo.id] }, "AE 김")).rejects.toThrow(/제품 사진을 고르세요/);
    await expect(images.generateImages(id, g, { ...base, method: "photo" }, "AE 김")).rejects.toThrow(/실제 사진/);
    expect(g.calls).toHaveLength(0);
  });

  it("장 수는 1~4장으로 맞추고, 중간에 실패하면 그때까지 받은 이미지는 남는다", async () => {
    const { id, gen } = await approvedCase();
    const prompt = await generateImagePrompt(svc, images, id, gen);
    let n = 0;
    const flaky: ImageGenerator = async () => {
      if (++n === 2) throw new ImageGenError("Gemini 사용량 한도에 걸렸습니다");
      return { blob: png(20), model: "gemini-test-image" };
    };
    await expect(images.generateImages(id, flaky, { promptId: prompt.id, count: 9, method: "prompt", toolName: imageToolName }, "AE 김")).rejects.toThrow(/한도/);
    expect((await images.getDoc(id)).items.filter((i) => i.source === "gemini")).toHaveLength(1);

    const g = recordingGen();
    await images.generateImages(id, g, { promptId: prompt.id, count: 9, method: "prompt", toolName: imageToolName }, "AE 김");
    expect(g.calls).toHaveLength(4);
  });
});
