import { beforeEach, describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { goodBrief, goodIdeas, goodImagePrompt, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { ImageService } from "@/core/imageService";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief, generateIdeas } from "@/llm/pipeline";
import { generateImagePrompt } from "@/llm/imagePipeline";
import { IntakeSchema, intakeForModel, intakeMismatches, mediaText, objectiveText } from "@/core/intake";
import { MENU_CLOSEUP_CANDIDATE, buildBrief, imagePolicyCandidates } from "@/core/brief";
import { routeFromDecision } from "@/core/images";
import { defaultComposeDoc } from "@/core/compose";
import { applySuggestion, parseSuggestion } from "@/core/revision";
import { readSkill } from "@/core/skills";

/** 2026-11-18 수강생 테스트(가상 카페 '오후세시커피') 보완 */

const base = () => structuredClone(intakeFixture) as Record<string, any>;
const parse = (raw: unknown) => IntakeSchema.parse(raw);

/** 가게 홍보, 제품 없음, 신메뉴 언급 (테스트에서 어긋났던 답) */
function cafeIntake() {
  const r = base();
  r.contact.company = "오후세시커피";
  r.answers["1"] = { text: "골목 안 작은 카페, 신메뉴 말차크림라떼 알리기", place: "서울 마포구 망원동 주택가 골목, 빨간 벽돌 2층 건물 1층", unknown: false };
  r.answers["3"] = { choice: "사이트·매장 방문", second: "매출", unknown: false };
  r.answers["9"] = { hasProduct: false };
  r.answers["10"] = { assets: ["매장·공간 사진", "로고 파일"], text: "", unknown: false };
  r.answers["11"] = { primary: "인스타그램·페이스북", also: ["네이버", "카카오"], other: "", size: "1080x1350", maxKB: null, unknown: false };
  return parse(r);
}

let store: MemoryStore;
let svc: CaseService;
let images: ImageService;
beforeEach(() => {
  store = new MemoryStore();
  svc = new CaseService(store, () => DEFAULT_SETTINGS);
  images = new ImageService(svc);
});

describe("질문지: 지역·목적 1/2순위·여러 매체·어긋난 답", () => {
  it("예전 답변 파일도 그대로 읽는다 (새 칸은 비어 있음, 예전 매체 목록은 '함께 집행'으로)", () => {
    const old = parse(base());
    expect(old.answers["1"].place).toBe("");
    expect(old.answers["3"].second).toBeNull();
    expect(old.answers["11"].also).toEqual([]);
    const r = base();
    r.answers["11"] = { channels: ["네이버", "카카오"], unknown: false };
    const m = parse(r).answers["11"];
    expect(m.primary).toBe("네이버");
    expect(m.also).toEqual(["카카오"]);
  });

  it("모델에 보내는 답과 한 줄 요약에 지역·2순위·함께 집행 매체가 들어간다", () => {
    const i = cafeIntake();
    const text = intakeForModel(i);
    expect(text).toContain("1번 가게 동네·지역·모습: 서울 마포구 망원동 주택가 골목");
    expect(text).toContain("3번 광고 목적: 1순위 사이트·매장 방문, 2순위 매출");
    expect(objectiveText(i.answers["3"])).toBe("1순위 사이트·매장 방문, 2순위 매출");
    expect(mediaText(i.answers["11"])).toBe("인스타그램·페이스북, 함께 집행: 네이버, 카카오, 사이즈 1080x1350");
    expect(text).not.toContain("가상 담당자");
  });

  it("9번 '제품 없음'인데 '신메뉴'를 말하면 확인을 부탁한다 (막지는 않음)", () => {
    const i = cafeIntake();
    const m = intakeMismatches(i);
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("'신메뉴'");
    expect(m[0]).toContain("실제 사진");
    // 제품 있음인데 제품 사진이 없다고 답한 경우
    const r = base();
    r.answers["10"] = { assets: ["로고 파일"], text: "", unknown: false };
    expect(intakeMismatches(parse(r)).join()).toContain("10번에 제품 사진이 없어요");
    // 원래 픽스처(쿠키, 제품·사진 있음)는 어긋남 없음
    expect(intakeMismatches(parse(base()))).toEqual([]);
  });
});

describe("브리프: 2순위 목적, 근거 표기, 어긋난 답", () => {
  it("목적은 1순위로 정하고 2순위를 함께 적으며, 근거가 없으면 '근거 근거 없음'처럼 겹쳐 쓰지 않는다", () => {
    const i = cafeIntake();
    const out = goodBrief();
    out.evidence = { status: "근거 없음", quotes: [] };
    const b = buildBrief(i, out, DEFAULT_SETTINGS, "m");
    expect(b.objectiveCategory).toBe("방문·인지");
    const row = (id: string) => b.rows.find((r) => r.id === id)!;
    expect(row("objective").content).toContain("(2순위: 매출)");
    expect(b.evidenceStatus).toBe("근거 없음");
    expect(row("evidence").label).toBe("근거");
    expect(row("evidence").content.startsWith("없음 (")).toBe(true);
    expect(b.issues.some((x) => x.where === "intake" && x.message.includes("신메뉴"))).toBe(true);
  });

  it("무형(가게)이면 이미지 방침 후보에 '메뉴 클로즈업(실제 사진 필요)'이 있고, 그 경로는 누끼다", () => {
    const c = imagePolicyCandidates(cafeIntake());
    expect(c).toContain(MENU_CLOSEUP_CANDIDATE);
    expect(MENU_CLOSEUP_CANDIDATE).toContain("실제 사진");
    expect(routeFromDecision(MENU_CLOSEUP_CANDIDATE, false)).toBe("product_cutout");
    expect(routeFromDecision(c[0], false)).toBe("intangible_ai");
  });
});

/** 무형 카페 케이스를 게이트 1까지 */
async function cafeCase(policyPick: (cands: string[]) => string) {
  const meta = await svc.createCase(JSON.parse(JSON.stringify(cafeIntake())));
  const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()], image_prompt: [goodImagePrompt()] });
  await generateBrief(svc, meta.id, gen, DEFAULT_SETTINGS);
  await generateIdeas(svc, meta.id, gen);
  const b = (await svc.getBrief(meta.id))!;
  for (const c of b.checklist) {
    const r = b.rows.find((x) => x.id === c.id)!;
    await svc.decide(meta.id, c.id, c.id === "imagePolicy" ? policyPick(r.candidates!) : r.candidates?.[0] ?? r.content, "AE 김");
  }
  await svc.approveGate1(meta.id, "idea-1", "AE 김");
  return { id: meta.id, gen };
}

const png = (bytes = 10) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

describe("이미지: 지역 반영, 메뉴 클로즈업은 실제 사진이 있어야", () => {
  it("이미지 프롬프트 요청에 동네·가게 모습이 들어간다", async () => {
    const { id, gen } = await cafeCase((c) => c[0]);
    await generateImagePrompt(svc, images, id, gen);
    const call = gen.calls.find((c) => c.purpose === "image_prompt")!;
    expect(call.user).toContain("가게가 있는 동네·지역·모습: 서울 마포구 망원동 주택가 골목");
    // 시스템 프롬프트의 원본(스킬)에 한국 거리 기본 규칙이 있다
    expect(readSkill("ad-image-router")).toContain("유럽·미국풍 거리로 그리지 않는다");
  });

  it("메뉴 클로즈업: 사진이 없으면 막고 요청하며, 사진을 올리면 누끼 경로로 진행된다", async () => {
    const { id, gen } = await cafeCase((c) => c.find((x) => x === MENU_CLOSEUP_CANDIDATE)!);
    let doc = await images.refreshPolicy(id);
    expect(doc.policy!.route).toBe("product_cutout");
    expect(doc.policy!.hasProduct).toBe(false);
    expect(doc.policy!.blockers.join()).toContain("대표 메뉴 사진 파일을 올려야");
    // 사진을 기다리는 중으로 바꿀 수 있다 (무형 케이스에서도)
    doc = await images.setRoute(id, "product_need_photo", "AE 김", "말차라떼 사진 요청");
    expect(doc.policy!.clientRequests.join()).toContain("대표 메뉴 사진");
    await expect(generateImagePrompt(svc, images, id, gen)).rejects.toThrow(/사진/);
    // 원본 기반 재생성은 무형 케이스에서 고를 수 없다
    await expect(images.setRoute(id, "product_regenerate", "AE 김")).rejects.toThrow(/고를 수 없는/);
    // 사진을 받으면 누끼로
    await images.addAsset(id, png(), "matcha.png", "product", "AE 김");
    doc = await images.setRoute(id, "product_cutout", "AE 김", "받은 사진으로");
    expect(doc.policy!.blockers).toEqual([]);
    const p = await generateImagePrompt(svc, images, id, gen);
    expect(p.promptEn).toMatch(/Do not draw the product itself/);
    const call = gen.calls.filter((c) => c.purpose === "image_prompt").pop()!;
    expect(call.user).toContain("메뉴 클로즈업");
  });
});

describe("합성: A/B 버튼 문구, 글자 뒤 띠, 배경 위치", () => {
  it("시안 B 는 A 와 다른 버튼 문구로 시작한다 (다른 후보가 있을 때)", async () => {
    const { id } = await cafeCase((c) => c[0]);
    const brief = (await svc.getBrief(id))!;
    const ideas = (await svc.getIdeas(id))!;
    const idea = ideas.ideas.find((x) => x.id === ideas.selectedId)!;
    const imgs = { version: 1 as const, policy: null, prompts: [], assets: [], items: [{ id: "s", file: "04_images/s.png", source: "upload" as const, role: "scene" as const, tool: "t", createdAt: "", createdBy: "", commercialUseChecked: true, checks: {}, status: "picked" as const, note: "" }] };
    const d = defaultComposeDoc(idea, brief, imgs, "AE 김");
    expect(d.variants.A.cta).toBeTruthy();
    expect(d.variants.B.cta).toBeTruthy();
    expect(d.variants.B.cta).not.toBe(d.variants.A.cta);
    expect(d.shared.band).toBe(0);
    expect(d.shared.scene).toEqual({ zoom: 1, dx: 0, dy: 0 });
  });

  it("AI 수정안은 띠·배경 위치도 허용 범위 안에서만 제안할 수 있다", async () => {
    const { id } = await cafeCase((c) => c[0]);
    const brief = (await svc.getBrief(id))!;
    const ideas = (await svc.getIdeas(id))!;
    const idea = ideas.ideas.find((x) => x.id === ideas.selectedId)!;
    const imgs = { version: 1 as const, policy: null, prompts: [], assets: [], items: [{ id: "s", file: "04_images/s.png", source: "upload" as const, role: "scene" as const, tool: "t", createdAt: "", createdBy: "", commercialUseChecked: true, checks: {}, status: "picked" as const, note: "" }] };
    const d = defaultComposeDoc(idea, brief, imgs, "AE 김");
    const ok = parseSuggestion({ field: "band", variant: "공통", value: "0.6", reason: "글자가 배경과 섞임" }, d)!;
    expect(ok).toMatchObject({ field: "band", value: 0.6 });
    expect(parseSuggestion({ field: "band", variant: "공통", value: "1.2", reason: "" }, d)).toBeNull();
    expect(parseSuggestion({ field: "sceneZoom", variant: "공통", value: "0.5", reason: "" }, d)).toBeNull();
    const zoom = parseSuggestion({ field: "sceneZoom", variant: "공통", value: "1.4", reason: "" }, d)!;
    const up = parseSuggestion({ field: "sceneDy", variant: "공통", value: "0.3", reason: "음료를 위로" }, d)!;
    const after = applySuggestion(applySuggestion(applySuggestion(d, ok), zoom), up);
    expect(after.shared.band).toBe(0.6);
    expect(after.shared.scene).toEqual({ zoom: 1.4, dx: 0, dy: 0.3 });
    expect(d.shared.band).toBe(0); // 원본은 그대로
  });
});
