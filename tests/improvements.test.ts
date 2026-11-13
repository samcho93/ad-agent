/** 테스트 후기(광고시안에이전트_후기와보완제안.docx) 보완 사항 */
import { beforeEach, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodImagePrompt, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { ImageService } from "@/core/imageService";
import { ComposeService } from "@/core/composeService";
import { QaService } from "@/core/qaService";
import { DeliveryService } from "@/core/deliveryService";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief, generateIdeas } from "@/llm/pipeline";
import { generateImagePrompt } from "@/llm/imagePipeline";
import { IntakeSchema, mediaText, parseSizeText, PRIVACY_NOTICE } from "@/core/intake";
import { SIZES, layoutFor, overlapIssues, overlapRatio, sizeOf, sizeShape, copyIssues } from "@/core/compose";
import { applicableCriteria } from "@/core/images";
import { humanChecklist } from "@/core/qa";
import { matchRule, ruleForPrompt, headlineLength, type ProductRule } from "@/core/productRules";

function png(w: number, h: number, pad = 64): Blob {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return new Blob([b], { type: "image/png" });
}
const baseRenders = () => (["A", "B"] as const).flatMap((v) => SIZES.map((s) => ({ variant: v, size: s, blob: png(sizeOf(s).w, sizeOf(s).h) })));

const juicer: ProductRule = {
  id: "rule_juicer",
  name: "쿠키",
  keywords: ["쿠키"],
  accent: "#3a8f3a",
  colorReason: "신선함",
  composition: "제품을 크게, 밝은 주방",
  maxHeadline: 8,
  note: "",
};

let store: MemoryStore;
let settings: Settings;
let svc: CaseService;
let images: ImageService;

beforeEach(() => {
  store = new MemoryStore();
  settings = structuredClone(DEFAULT_SETTINGS);
  svc = new CaseService(store, () => settings);
  images = new ImageService(svc);
});

/** 게이트 1까지. imagePolicy 를 직접 정할 수 있다 */
async function approvedCase(intake: unknown = intakeFixture, imagePolicy?: string) {
  const meta = await svc.createCase(intake);
  const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()] });
  await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
  await generateIdeas(svc, meta.id, gen);
  const b = (await svc.getBrief(meta.id))!;
  for (const c of b.checklist) {
    const r = b.rows.find((x) => x.id === c.id)!;
    await svc.decide(meta.id, c.id, c.id === "imagePolicy" && imagePolicy ? imagePolicy : r.candidates?.[0] ?? r.content, "AE 김");
  }
  await svc.approveGate1(meta.id, "idea-2", "AE 김");
  return { id: meta.id, gen };
}

describe("1. 사진 요청 중 → 사진 받음", () => {
  it("'사진 없음'으로 확정해도 이미지 단계에서 사진을 받으면 누끼 경로로 이어진다", async () => {
    const { id, gen } = await approvedCase(intakeFixture, "제품형, 사진 없음: 광고주에게 사진 요청");
    let doc = await images.refreshPolicy(id);
    expect(doc.policy!.route).toBe("product_need_photo");
    expect(doc.policy!.blockers.join()).toMatch(/요청 중/);
    await expect(generateImagePrompt(svc, images, id, gen)).rejects.toThrow(/사진을 요청/);

    await images.addAsset(id, png(800, 800), "cookie.png", "product", "AE 김");
    doc = await images.getDoc(id);
    expect(doc.policy!.blockers.join()).toMatch(/사진을 받았습니다/);

    await expect(images.setRoute(id, "intangible_ai", "AE 김")).rejects.toThrow(/고를 수 없는 경로/);
    doc = await images.setRoute(id, "product_cutout", "AE 김", "광고주가 사진을 보냄");
    expect(doc.policy!.route).toBe("product_cutout");
    expect(doc.policy!.reason).toMatch(/이미지 단계에서 바꿈 \(AE 김/);
    expect(await svc.readApprovals(id)).toMatch(/이미지 방침 변경 \| AE 김 \| .*사진 요청.*→.*누끼/);
    expect(await store.read(id, "04_images/policy.md")).toContain("누끼");
    const prompt = await generateImagePrompt(svc, images, id, gen);
    expect(prompt.promptEn).toMatch(/Do not draw the product/);
  });
});

describe("2. 매체 질문: 대표 매체 1개 + 선택 입력", () => {
  it("예전 답변 파일(여러 매체)도 읽고, 새 형식은 사이즈·용량을 검사한다", () => {
    const legacy = structuredClone(intakeFixture) as Record<string, any>;
    legacy.answers["11"] = { channels: ["네이버", "카카오"], unknown: false };
    const a = IntakeSchema.parse(legacy).answers["11"];
    expect(a.primary).toBe("네이버");
    expect(mediaText(a)).toContain("카카오");

    const next = structuredClone(intakeFixture) as Record<string, any>;
    next.answers["11"] = { primary: "기타", other: "당근 비즈프로필", size: "1080×1350", maxKB: 500, unknown: false };
    const n = IntakeSchema.parse(next).answers["11"];
    expect(mediaText(n)).toBe("당근 비즈프로필, 사이즈 1080×1350, 용량 한도 500KB");
    next.answers["11"].size = "큰 거";
    expect(IntakeSchema.safeParse(next).success).toBe(false);
    expect(parseSizeText("300 x 250")).toEqual({ w: 300, h: 250 });
    expect(parseSizeText("10x10")).toBeNull();
  });

  it("개인정보 안내는 초안 표시와 함께 목적·전송 대상·거부 권리를 담고, 보관 기간은 정하지 않는다", () => {
    expect(PRIVACY_NOTICE.draft).toBe(true);
    const labels = PRIVACY_NOTICE.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["이용 목적", "전송될 수 있는 곳", "동의하지 않을 권리", "보관 기간"]));
    expect(PRIVACY_NOTICE.items.find((i) => i.label === "보관 기간")!.text).toMatch(/미정.*미정/);
  });
});

describe("5. 합성: 사이즈별 배치와 겹침", () => {
  it("기본 3종 배치는 그대로이고, 다른 사이즈는 가까운 배치로 영역 안에 들어간다", () => {
    expect(layoutFor("1080x1080", "위").headline.start).toBe(76);
    expect(layoutFor("1200x628", "왼쪽").headline.start).toBe(62);
    expect(layoutFor("320x100", "위").cta.size).toBe(12);
    for (const size of ["1080x1350", "1080x1920", "1920x1080", "728x90", "300x250", "160x600"]) {
      for (const cs of ["위", "아래", "왼쪽", "오른쪽"] as const) {
        const L = layoutFor(size, cs);
        for (const b of [L.text, L.product]) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w).toBeLessThanOrEqual(L.W);
          expect(b.y + b.h).toBeLessThanOrEqual(L.H);
        }
      }
    }
    expect(sizeShape("728x90")).toBe("band");
    expect(sizeShape("1920x1080")).toBe("landscape");
    expect(sizeShape("1080x1350")).toBe("square");
  });

  it("제품이 헤드라인·버튼과 겹치면 알려 준다 (3% 넘을 때)", () => {
    const product = { x: 100, y: 100, w: 400, h: 400 };
    expect(overlapRatio(product, { x: 300, y: 300, w: 400, h: 400 })).toBeCloseTo(0.25);
    const msgs = overlapIssues(product, [
      { what: "헤드라인", box: { x: 50, y: 80, w: 300, h: 60 } },
      { what: "서브카피", box: { x: 50, y: 520, w: 300, h: 40 } },
      { what: "버튼", box: { x: 480, y: 480, w: 100, h: 40 } },
    ]);
    expect(msgs.join()).toMatch(/제품이 헤드라인과 겹칩니다/);
    expect(msgs.join()).not.toMatch(/서브카피/);
    expect(msgs.join()).toMatch(/버튼과/);
    expect(overlapIssues(null, [{ what: "헤드라인", box: { x: 0, y: 0, w: 10, h: 10 } }])).toEqual([]);
  });
});

describe("7. 제품 종류별 규칙", () => {
  it("1부 1번에 키워드가 있으면 규칙을 찾아 프롬프트에 넣고, 합성 첫 색과 헤드라인 길이에 쓴다", async () => {
    settings.productRules = [juicer];
    const intake = IntakeSchema.parse(intakeFixture);
    expect(matchRule(settings.productRules, intake)?.name).toBe("쿠키");
    expect(ruleForPrompt(juicer)).toMatch(/강조색: #3a8f3a \(신선함\)/);
    expect(headlineLength("버터 100%,\n그날 구운 것만")).toBe(13);

    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
    await generateIdeas(svc, meta.id, gen);
    expect(gen.calls.find((c) => c.purpose === "ideas")!.user).toMatch(/<제품_종류_규칙 이름="쿠키">/);
  });

  it("규칙이 없으면 기본 색과 그 이유를, 있으면 규칙 색과 이유를 남긴다", async () => {
    const { id } = await approvedCase();
    const asset = await images.addAsset(id, png(800, 800), "cookie.png", "product", "AE 김");
    const scene = await images.addImage(id, png(1024, 1024), { source: "upload", role: "scene", tool: "Figma AI", method: "product_reference", referenceAssetIds: [asset.id] }, "AE 김");
    expect(scene.method).toBe("product_reference");
    expect(JSON.stringify(await images.readLog(id))).toContain('"method":"product_reference"');
    await expect(images.addImage(id, png(10, 10), { source: "upload", role: "scene", tool: "x", method: "product_reference", referenceAssetIds: ["nope"] }, "AE 김")).rejects.toThrow(/참조로 넣은 제품 사진/);
    const cut = await images.addImage(id, png(600, 600), { source: "cutout", role: "cutout", tool: "누끼", fromAssetId: asset.id }, "AE 김");
    const doc = await images.getDoc(id);
    for (const it of [scene, cut]) {
      await images.updateImage(id, it.id, { commercialUseChecked: true, checks: Object.fromEntries(applicableCriteria(it, doc.policy).map((c) => [c, true])), status: "picked" }, "AE 김");
    }
    await images.complete(id, "AE 김");

    settings.productRules = [juicer];
    const compose = new ComposeService(svc);
    const cdoc = await compose.ensureDoc(id, "AE 김");
    expect(cdoc.variants.A.buttonBg).toBe("#3a8f3a");
    expect(cdoc.variants.B.buttonBg).toBe("#2f5d50");
    expect(cdoc.colorSource!.reason).toMatch(/제품 종류 규칙 "쿠키".*신선함/);
    const issues = await compose.copyIssues(id, cdoc);
    expect(issues.some((i) => i.severity === "warning" && /규칙 "쿠키"의 8자/.test(i.message))).toBe(true);

    expect(copyIssues(cdoc, "", [], null).some((i) => /규칙/.test(i.message))).toBe(false);
    expect(mergeSettings({ llm: DEFAULT_SETTINGS.llm } as Partial<Settings>).productRules).toEqual([]);
  });
});

describe("변형 단계: 고른 시안에 사이즈 추가", () => {
  it("추가 사이즈는 저장·사람 확인 뒤에 납품 ZIP 에 들어가고, 수정 요청이 오면 다시 저장해야 한다", async () => {
    const intake = structuredClone(intakeFixture) as Record<string, any>;
    intake.answers["11"] = { primary: "인스타그램·페이스북", other: "", size: "1080x1350", maxKB: 300, unknown: false };
    const { id } = await approvedCase(intake);
    const asset = await images.addAsset(id, png(800, 800), "cookie.png", "product", "AE 김");
    const scene = await images.addImage(id, png(1024, 1024), { source: "upload", role: "scene", tool: "Figma" }, "AE 김");
    const cut = await images.addImage(id, png(600, 600), { source: "cutout", role: "cutout", tool: "누끼", fromAssetId: asset.id }, "AE 김");
    const idoc = await images.getDoc(id);
    for (const it of [scene, cut]) {
      await images.updateImage(id, it.id, { commercialUseChecked: true, checks: Object.fromEntries(applicableCriteria(it, idoc.policy).map((c) => [c, true])), status: "picked" }, "AE 김");
    }
    await images.complete(id, "AE 김");
    const compose = new ComposeService(svc);
    await compose.ensureDoc(id, "AE 김");
    await compose.saveRenders(id, baseRenders(), [], "AE 김");

    const qa = new QaService(svc);
    const q = await qa.run(id, "디자이너 박");
    // 광고주가 적은 용량 한도(300KB)를 쓴다
    expect(q.checks.some((c) => c.message.includes("용량 한도: 확인 필요"))).toBe(false);
    expect(humanChecklist(q)).toContain("디자인 마무리 확인 (제품·문구 균형, 겹침, 배치)");
    for (const h of humanChecklist(q)) await qa.setHuman(id, h, true, "디자이너 박");
    await qa.approveGate2(id, "디자이너 박");

    const delivery = new DeliveryService(svc);
    await expect(delivery.addExtraSize(id, "1080x1350", "", "AE 김")).rejects.toThrow(/확정한 뒤/);
    const proof = await delivery.makeProof(id, "AE 김");
    await delivery.importAnswer(id, { format: "ad-agent-proof-answer", version: 1, proofId: proof.proofId, caseId: id, answeredAt: new Date().toISOString(), decision: "confirm", variant: "A", requests: [], comment: "" }, "AE 김");

    await expect(delivery.addExtraSize(id, "1080x1080", "", "AE 김")).rejects.toThrow(/이미 있습니다/);
    await expect(delivery.addExtraSize(id, "크게", "", "AE 김")).rejects.toThrow(/가로x세로/);
    await delivery.addExtraSize(id, "1080 x 1350", "인스타 세로 피드", "AE 김");
    let ready = await delivery.readiness(id);
    expect(ready.blockers.join()).toMatch(/1080x1350: PNG를 저장/);

    await expect(delivery.saveExtraRenders(id, [{ size: "1080x1350", blob: png(1080, 1080) }], [], "AE 김")).rejects.toThrow(/크기가 맞지 않습니다/);
    await expect(delivery.saveExtraRenders(id, [{ size: "1080x1350", blob: png(1080, 1350) }], ["1080x1350: 헤드라인이 영역을 넘칩니다"], "AE 김")).rejects.toThrow(/넘칩니다/);
    await delivery.saveExtraRenders(id, [{ size: "1080x1350", blob: png(1080, 1350) }], [], "AE 김");
    ready = await delivery.readiness(id);
    expect(ready.blockers.join()).toMatch(/사람이 확인/);
    await delivery.checkExtraSize(id, "1080x1350", true, "디자이너 박");
    expect((await delivery.readiness(id)).ok).toBe(true);

    const files = unzipSync((await delivery.exportZip(id, "AE 김")).bytes);
    expect(Object.keys(files)).toContain("A_1080x1350.png");
    expect(strFromU8(files["README.txt"])).toMatch(/1080x1350: 인스타 세로 피드 \(확인: 디자이너 박\)/);
  });
});
