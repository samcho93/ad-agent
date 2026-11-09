import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import intakeFixture from "./fixtures/cookie-intake.json";
import { badBrief, goodBrief, goodIdeas, scriptedGenerator } from "@/llm/fake";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ad-agent-"));
  process.env.AD_AGENT_CASES_DIR = tmp;
});

const load = async () => {
  const caseMod = await import("@/core/case");
  const pipe = await import("@/llm/pipeline");
  return { ...caseMod, ...pipe };
};

describe("1단계: 질문지 → 브리프 → 아이디어 → 게이트 1 (가상 쿠키 가게)", () => {
  it("필수 동의가 없으면 케이스를 만들지 않는다", async () => {
    const { createCase } = await load();
    const bad = structuredClone(intakeFixture) as Record<string, any>;
    bad.consent.privacy = false;
    expect(() => createCase(bad)).toThrow(/질문지 형식 오류/);
  });

  it("규칙을 어긴 첫 응답은 재시도하고, 태그와 추정 표시는 코드가 붙인다", async () => {
    const { createCase, generateBrief, getBrief } = await load();
    const meta = createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [badBrief(), goodBrief()] });
    await generateBrief(meta.id, gen);
    expect(gen.calls.length).toBe(2);
    expect(gen.calls[1].user).toContain("검증_오류");
    // 담당자 이름·연락처는 모델에 보내지 않는다
    for (const c of gen.calls) {
      expect(c.user).not.toContain("가상 담당자");
      expect(c.user).not.toContain("010-0000-0000");
    }

    const brief = getBrief(meta.id)!;
    const row = (id: string) => brief.rows.find((r) => r.id === id)!;

    // 모든 행에 출처 태그
    for (const r of brief.rows) expect(r.tags.length).toBeGreaterThan(0);

    // 3번 모르겠음 → 목적 추정
    expect(brief.objectiveEstimated).toBe(true);
    expect(row("objective").tags.some((t) => t.kind === "estimate")).toBe(true);
    expect(row("objective").content).toContain("추정");
    // 2번 모르겠음 → 타깃 추정
    expect(row("target").tags.some((t) => t.kind === "estimate")).toBe(true);
    // 11번 모르겠음 → 매체 추정
    expect(row("media").tags.some((t) => t.kind === "estimate")).toBe(true);
    // 1번은 답이 있으므로 추정 아님
    expect(row("client").estimated).toBe(false);

    // 근거: 1부 6번에 없는 "고객 만족도 98%"는 빠진다
    expect(brief.evidenceQuotes).toEqual(["버터 100% 사용"]);
    expect(brief.issues.some((i) => i.where === "evidence" && i.message.includes("만족도"))).toBe(true);

    // 사용자 결정 항목은 후보만 있고 체크리스트에 들어간다
    for (const id of ["insight", "keyMessage", "cta", "deliverable", "revisions", "imagePolicy"]) {
      expect(brief.checklist.some((c) => c.id === id)).toBe(true);
    }
    expect(row("insight").candidates).toHaveLength(3);
    // 미정 항목은 미정으로 남는다
    expect(row("revisions").content).toContain("미정");
    // 이미지 방침: 제품형 + 사진 있음 → 누끼 경로
    expect(row("imagePolicy").candidates![0]).toContain("누끼");

    const md = fs.readFileSync(path.join(tmp, meta.id, "02_brief.md"), "utf8");
    expect(md).toContain("[1부 답 3번] [추정]");
    expect(md).toContain("[사용자 결정]");
    expect(md).toContain("## 사람이 확정할 항목");
    expect(md).toContain("캡처 요청: 옆 동네 쿠키 공방");
  });

  it("두 번 다 규칙을 어기면 오류를 체크리스트에 남긴다", async () => {
    const { createCase, generateBrief } = await load();
    const meta = createCase(intakeFixture);
    const brief = await generateBrief(meta.id, scriptedGenerator({ brief: [badBrief()] }));
    const errs = brief.issues.filter((i) => i.severity === "error");
    expect(errs.some((e) => e.where === "benefit" && e.message.includes("1"))).toBe(true);
    expect(errs.some((e) => e.where === "target")).toBe(true);
    expect(errs.some((e) => e.where === "keyMessage" && e.message.includes("최고"))).toBe(true);
    expect(brief.checklist.find((c) => c.id === "benefit")!.reasons.join()).toContain("검증 오류");
  });

  it("게이트 1: 확정 항목과 아이디어 선택이 모두 있어야 승인되고, 승인 후에는 잠긴다", async () => {
    const { createCase, generateBrief, generateIdeas, decide, gate1Readiness, approveGate1, getBrief, getMeta, readApprovals } = await load();
    const meta = createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(meta.id, gen);
    const ideas = await generateIdeas(meta.id, gen);

    // 문의·상담(추정) → 방향표 행
    expect(ideas.ideas.map((x) => x.direction)).toEqual(["고민 공감", "믿을 근거 (후기, 경력, 수치)", "부담 없는 첫걸음 (무료 상담, 간단 신청)"]);
    // 목적이 추정이므로 모든 안에 [추정]
    for (const x of ideas.ideas) expect(x.tags.map((t) => t.kind)).toEqual(["ai", "estimate"]);

    expect(gate1Readiness(meta.id, "idea-1").ok).toBe(false);
    expect(() => approveGate1(meta.id, "idea-1", "AE 김")).toThrow(/확정하지 않은 항목/);

    for (const c of getBrief(meta.id)!.checklist) {
      const r = getBrief(meta.id)!.rows.find((x) => x.id === c.id)!;
      decide(meta.id, c.id, r.candidates?.[0] ?? r.content, "AE 김");
    }
    expect(gate1Readiness(meta.id, "idea-2").ok).toBe(true);
    expect(() => approveGate1(meta.id, "idea-2", "")).toThrow(/승인자/);

    approveGate1(meta.id, "idea-2", "AE 김", "근거 자료 추가 요청함");
    expect(getMeta(meta.id).status).toBe("gate1_approved");
    const approvals = readApprovals(meta.id);
    expect(approvals).toContain("게이트 1 | AE 김 | 아이디어 2안");
    const md = fs.readFileSync(path.join(tmp, meta.id, "02_brief.md"), "utf8");
    expect(md).toContain("상태: **확정**");
    expect(md).toContain("**확정:**");

    // 잠금
    await expect(generateBrief(meta.id, gen)).rejects.toThrow(/게이트 1/);
    expect(() => decide(meta.id, "cta", "x", "AE 김")).toThrow(/게이트 1/);
  });

  it("사람이 목적을 바꿔 확정하면 아이디어를 다시 만들어야 한다", async () => {
    const { createCase, generateBrief, generateIdeas, decide, gate1Readiness, getBrief } = await load();
    const meta = createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(meta.id, gen);
    await generateIdeas(meta.id, gen); // 문의·상담(추정) 기준
    decide(meta.id, "objective", "목적: 방문·인지. KPI: 길찾기 클릭 수", "AE 김");
    expect(getBrief(meta.id)!.objectiveCategory).toBe("방문·인지");
    expect(getBrief(meta.id)!.objectiveEstimated).toBe(false);
    expect(gate1Readiness(meta.id, "idea-1").blockers.join()).toContain("확정한 목적(방문·인지)");
    const ideas = await generateIdeas(meta.id, gen);
    expect(ideas.ideas[0].direction).toBe("감성 (분위기, 공간)");
    expect(ideas.ideas[0].tags.map((t) => t.kind)).toEqual(["ai"]); // 목적이 확정되어 추정 아님
  });

  it("브리프를 다시 만들면 이전 아이디어로는 게이트 1을 못 넘는다", async () => {
    const { createCase, generateBrief, generateIdeas, gate1Readiness } = await load();
    const meta = createCase(intakeFixture);
    const gen = scriptedGenerator({ brief: [goodBrief()], ideas: [goodIdeas()] });
    await generateBrief(meta.id, gen);
    await generateIdeas(meta.id, gen);
    await new Promise((r) => setTimeout(r, 5));
    await generateBrief(meta.id, gen);
    expect(gate1Readiness(meta.id, "idea-1").blockers.join()).toContain("아이디어를 다시 만드세요");
  });
});
