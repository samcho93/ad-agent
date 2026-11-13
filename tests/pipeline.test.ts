import { beforeEach, describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { badBrief, goodBrief, goodIdeas, scriptedGenerator } from "@/llm/fake";
import { CaseService } from "@/core/caseService";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { MemoryStore } from "@/storage/memory";
import { generateBrief as genBrief, generateIdeas as genIdeas } from "@/llm/pipeline";
import type { Generator } from "@/llm/generator";

let store: MemoryStore;
let svc: CaseService;
beforeEach(() => {
  store = new MemoryStore();
  svc = new CaseService(store, () => DEFAULT_SETTINGS);
});

const generateBrief = (id: string, gen: Generator) => genBrief(svc, id, gen, DEFAULT_SETTINGS);
const generateIdeas = (id: string, gen: Generator) => genIdeas(svc, id, gen);

describe("1단계: 질문지 → 브리프 → 아이디어 → 게이트 1 (가상 쿠키 가게)", () => {
  it("필수 동의가 없으면 케이스를 만들지 않는다", async () => {
    const bad = structuredClone(intakeFixture) as Record<string, any>;
    bad.consent.privacy = false;
    await expect(svc.createCase(bad)).rejects.toThrow(/질문지 형식 오류/);
  });

  it("규칙을 어긴 첫 응답은 재시도하고, 태그와 추정 표시는 코드가 붙인다", async () => {
    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [badBrief(), goodBrief()] });
    await generateBrief(meta.id, gen);
    expect(gen.calls.length).toBe(2);
    expect(gen.calls[1].user).toContain("검증_오류");
    // 담당자 이름·연락처는 모델에 보내지 않는다
    for (const c of gen.calls) {
      expect(c.user).not.toContain("가상 담당자");
      expect(c.user).not.toContain("010-0000-0000");
    }

    const brief = (await svc.getBrief(meta.id))!;
    const row = (id: string) => brief.rows.find((r) => r.id === id)!;

    for (const r of brief.rows) expect(r.tags.length).toBeGreaterThan(0);
    expect(brief.objectiveEstimated).toBe(true);
    expect(row("objective").tags.some((t) => t.kind === "estimate")).toBe(true);
    expect(row("objective").content).toContain("추정");
    expect(row("target").tags.some((t) => t.kind === "estimate")).toBe(true);
    expect(row("media").tags.some((t) => t.kind === "estimate")).toBe(true);
    expect(row("client").estimated).toBe(false);

    expect(brief.evidenceQuotes).toEqual(["버터 100% 사용"]);
    expect(brief.issues.some((i) => i.where === "evidence" && i.message.includes("만족도"))).toBe(true);

    for (const id of ["insight", "keyMessage", "cta", "deliverable", "revisions", "imagePolicy"]) {
      expect(brief.checklist.some((c) => c.id === id)).toBe(true);
    }
    expect(row("insight").candidates).toHaveLength(3);
    expect(row("revisions").content).toContain("미정");
    expect(row("imagePolicy").candidates![0]).toContain("누끼");

    const md = (await store.read(meta.id, "02_brief.md"))!;
    expect(md).toContain("[1부 답 3번] [추정]");
    expect(md).toContain("[사용자 결정]");
    expect(md).toContain("## 사람이 확정할 항목");
    expect(md).toContain("캡처 요청: 옆 동네 쿠키 공방");
    // 로그에 비밀값·프롬프트 원문이 없다
    const log = (await store.read(meta.id, "llm_log.jsonl"))!;
    expect(log).not.toContain("<광고주_자료>");
  });

  it("두 번 다 규칙을 어기면 오류를 체크리스트에 남긴다", async () => {
    const meta = await svc.createCase(intakeFixture);
    const brief = await generateBrief(meta.id, scriptedGenerator({ brief: [badBrief()] }));
    const errs = brief.issues.filter((i) => i.severity === "error");
    expect(errs.some((e) => e.where === "benefit" && e.message.includes("1"))).toBe(true);
    expect(errs.some((e) => e.where === "target")).toBe(true);
    expect(errs.some((e) => e.where === "keyMessage" && e.message.includes("최고"))).toBe(true);
    expect(brief.checklist.find((c) => c.id === "benefit")!.reasons.join()).toContain("검증 오류");
  });

  it("게이트 1: 확정 항목과 아이디어 선택이 모두 있어야 승인되고, 승인 후에는 잠긴다", async () => {
    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(meta.id, gen);
    const ideas = await generateIdeas(meta.id, gen);

    expect(ideas.ideas.map((x) => x.direction)).toEqual(["고민 공감", "믿을 근거 (후기, 경력, 수치)", "부담 없는 첫걸음 (무료 상담, 간단 신청)"]);
    for (const x of ideas.ideas) expect(x.tags.map((t) => t.kind)).toEqual(["ai", "estimate"]);

    expect((await svc.gate1Readiness(meta.id, "idea-1")).ok).toBe(false);
    await expect(svc.approveGate1(meta.id, "idea-1", "AE 김")).rejects.toThrow(/확정하지 않은 항목/);

    const b = (await svc.getBrief(meta.id))!;
    for (const c of b.checklist) {
      const r = b.rows.find((x) => x.id === c.id)!;
      await svc.decide(meta.id, c.id, r.candidates?.[0] ?? r.content, "AE 김");
    }
    expect((await svc.gate1Readiness(meta.id, "idea-2")).ok).toBe(true);
    await expect(svc.approveGate1(meta.id, "idea-2", "")).rejects.toThrow(/승인자/);

    await svc.approveGate1(meta.id, "idea-2", "AE 김", "근거 자료 추가 요청함");
    expect((await svc.getMeta(meta.id)).status).toBe("gate1_approved");
    expect(await svc.readApprovals(meta.id)).toContain("게이트 1 | AE 김 | 아이디어 2안");
    const md = (await store.read(meta.id, "02_brief.md"))!;
    expect(md).toContain("상태: **확정**");
    expect(md).toContain("**확정:**");

    await expect(generateBrief(meta.id, gen)).rejects.toThrow(/게이트 1/);
    await expect(svc.decide(meta.id, "cta", "x", "AE 김")).rejects.toThrow(/게이트 1/);
  });

  it("사람이 목적을 바꿔 확정하면 아이디어를 다시 만들어야 한다", async () => {
    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(meta.id, gen);
    await generateIdeas(meta.id, gen);
    await svc.decide(meta.id, "objective", "목적: 방문·인지. KPI: 길찾기 클릭 수", "AE 김");
    expect((await svc.getBrief(meta.id))!.objectiveCategory).toBe("방문·인지");
    expect((await svc.getBrief(meta.id))!.objectiveEstimated).toBe(false);
    expect((await svc.gate1Readiness(meta.id, "idea-1")).blockers.join()).toContain("확정한 목적(방문·인지)");
    const ideas = await generateIdeas(meta.id, gen);
    expect(ideas.ideas[0].direction).toBe("감성 (분위기, 공간)");
    expect(ideas.ideas[0].tags.map((t) => t.kind)).toEqual(["ai"]);
  });

  it("브리프를 다시 만들면 이전 아이디어로는 게이트 1을 못 넘는다", async () => {
    const meta = await svc.createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(meta.id, gen);
    await generateIdeas(meta.id, gen);
    await new Promise((r) => setTimeout(r, 5));
    await generateBrief(meta.id, gen);
    expect((await svc.gate1Readiness(meta.id, "idea-1")).blockers.join()).toContain("아이디어를 다시 만드세요");
  });
});

describe("케이스 내보내기·가져오기", () => {
  it("다른 저장소로 옮겨도 그대로 이어서 작업할 수 있다", async () => {
    const meta = await svc.createCase(intakeFixture);
    await generateBrief(meta.id, scriptedGenerator({ brief: [goodBrief()] }));
    const bundle = await svc.exportCase(meta.id);
    expect(Object.keys(bundle.files)).toContain("02_brief.md");

    const other = new CaseService(new MemoryStore(), () => DEFAULT_SETTINGS);
    const imported = await other.importCase(JSON.parse(JSON.stringify(bundle)));
    expect(imported.id).toBe(meta.id);
    expect((await other.getBrief(imported.id))!.rows.length).toBeGreaterThan(10);
    // 같은 저장소에 다시 가져오면 새 id
    const again = await svc.importCase(bundle);
    expect(again.id).toBe(`${meta.id}-2`);
  });

  it("형식이 다르면 거부하고, 경로 조작·케이스가 아닌 파일은 쓰지 않고 건너뛴다", async () => {
    await expect(svc.importCase({ hello: 1 })).rejects.toThrow(/형식/);
    await expect(svc.importCase({ format: "ad-agent-case", version: 1, files: { "../x": "a" } })).rejects.toThrow(/필수 파일/);

    // 예전 PC 폴더 저장소 내보내기: 케이스 폴더에 넣어 둔 내보내기 파일·desktop.ini 까지 들어 있던 경우
    const meta = await svc.createCase(intakeFixture);
    const bundle = await svc.exportCase(meta.id);
    bundle.files["케이스_한국폴리텍대학-분당융합기술교육원_20261110.json"] = "{}";
    bundle.files["../../evil.txt"] = "x";
    bundle.binaries = { ...(bundle.binaries ?? {}), "assets/a.exe": { type: "application/octet-stream", base64: "AAAA" } };
    const store2 = new MemoryStore();
    const other = new CaseService(store2, () => DEFAULT_SETTINGS);
    const imported = await other.importCase(bundle);
    expect(imported.skipped.sort()).toEqual(["../../evil.txt", "assets/a.exe", "케이스_한국폴리텍대학-분당융합기술교육원_20261110.json"].sort());
    expect((await store2.listFiles(imported.id)).some((f) => /evil|케이스_|exe/.test(f))).toBe(false);
    expect(await other.getIntake(imported.id)).toBeTruthy();
  });
});
