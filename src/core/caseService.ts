import type { CaseStore } from "@/storage/types";
import { CASE_ID_RE, FILE_NAME_RE } from "@/storage/types";
import { IntakeSchema, type Intake } from "./intake";
import { type BriefDoc, buildChecklist, renderBriefMarkdown, unresolved, OBJECTIVE_CATEGORIES } from "./brief";
import { type IdeasDoc, renderIdeasMarkdown } from "./ideas";
import type { Settings } from "./settings";

/** 9단계 진행 (docs/architecture.md 8절) */
export const STAGES = [
  { key: "intake", label: "질문 수집" },
  { key: "brief", label: "브리프" },
  { key: "ideas", label: "아이디어" },
  { key: "gate1", label: "게이트 1", gate: true },
  { key: "images", label: "이미지" },
  { key: "compose", label: "합성" },
  { key: "qa", label: "검수" },
  { key: "gate2", label: "게이트 2", gate: true },
  { key: "export", label: "납품" },
] as const;

export type CaseStatus = "intake_done" | "brief_draft" | "ideas_draft" | "gate1_approved";

export interface CaseMeta {
  id: string;
  company: string;
  createdAt: string;
  updatedAt: string;
  status: CaseStatus;
  backend: string;
  /** 심의 업종이면 게이트 1 뒤에 단계가 추가된다 */
  extraSteps: string[];
}

export class CaseError extends Error {}

export interface Gate1Readiness {
  ok: boolean;
  blockers: string[];
}

/** 케이스 내보내기 파일 형식 (다른 사람·다른 PC로 넘길 때) */
export interface CaseBundle {
  format: "ad-agent-case";
  version: 1;
  exportedAt: string;
  caseId: string;
  files: Record<string, string>;
}

function slug(company: string): string {
  return (
    company
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "case"
  );
}

const ymd = (d = new Date()) => d.toISOString().slice(0, 10).replace(/-/g, "");
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export class CaseService {
  constructor(
    readonly store: CaseStore,
    private settings: () => Settings,
  ) {}

  /* ---------------- 읽기 ---------------- */

  private async readJson<T>(id: string, name: string): Promise<T | null> {
    const raw = await this.store.read(id, name);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async listCases(): Promise<CaseMeta[]> {
    const metas: CaseMeta[] = [];
    for (const id of await this.store.listCaseIds()) {
      const m = await this.readJson<CaseMeta>(id, "00_case.json").catch(() => null);
      if (m) metas.push(m);
    }
    return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getMeta(id: string): Promise<CaseMeta> {
    if (!CASE_ID_RE.test(id)) throw new CaseError("잘못된 케이스 id");
    const m = await this.readJson<CaseMeta>(id, "00_case.json");
    if (!m) throw new CaseError("케이스가 없습니다");
    return m;
  }

  async getIntake(id: string): Promise<Intake> {
    return IntakeSchema.parse(await this.readJson(id, "01_intake.json"));
  }
  getBrief(id: string) {
    return this.readJson<BriefDoc>(id, "02_brief.json");
  }
  getIdeas(id: string) {
    return this.readJson<IdeasDoc>(id, "03_ideas.json");
  }
  async readApprovals(id: string) {
    return (await this.store.read(id, "approvals.md")) ?? "";
  }

  /* ---------------- 생성 ---------------- */

  async createCase(input: unknown): Promise<CaseMeta> {
    const parsed = IntakeSchema.safeParse(input);
    if (!parsed.success) {
      throw new CaseError(`질문지 형식 오류: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const intake = parsed.data;
    const id = await this.freeId(`${slug(intake.contact.company)}_${ymd()}`);
    const now = new Date().toISOString();
    const s = this.settings();
    const meta: CaseMeta = { id, company: intake.contact.company, createdAt: now, updatedAt: now, status: "intake_done", backend: s.composeBackend, extraSteps: [] };
    await this.store.write(id, "01_intake.json", json(intake));
    await this.store.write(id, "approvals.md", `# 승인 기록 — ${intake.contact.company}\n\n| 시각 | 게이트 | 승인자 | 내용 |\n|---|---|---|---|\n`);
    await this.store.write(id, "revisions.md", `# 수정 기록\n\n포함 수정 횟수: ${s.revision.includedCount}\n\n`);
    await this.store.write(id, "00_case.json", json(meta)); // 마지막에 써서 "완성된 케이스"의 표시로 쓴다
    return meta;
  }

  private async freeId(base: string): Promise<string> {
    let id = base;
    for (let n = 2; await this.store.caseExists(id); n++) id = `${base}-${n}`;
    return id;
  }

  /* ---------------- 저장 ---------------- */

  private async saveMeta(meta: CaseMeta) {
    meta.updatedAt = new Date().toISOString();
    await this.store.write(meta.id, "00_case.json", json(meta));
  }

  private assertNotLocked(meta: CaseMeta) {
    if (meta.status === "gate1_approved") throw new CaseError("게이트 1이 승인된 케이스는 브리프·아이디어를 바꿀 수 없습니다");
  }

  async assertEditable(id: string) {
    this.assertNotLocked(await this.getMeta(id));
  }

  async log(id: string, entry: Record<string, unknown>) {
    // 프롬프트 원문과 비밀값은 남기지 않는다. 용도, 모델, 사용량, 검증 결과만 기록한다.
    await this.store.append(id, "llm_log.jsonl", JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  }

  async saveBrief(id: string, brief: BriefDoc) {
    const meta = await this.getMeta(id);
    this.assertNotLocked(meta);
    await this.store.write(id, "02_brief.json", json(brief));
    await this.store.write(id, "02_brief.md", renderBriefMarkdown(brief, meta.company));
    // 브리프가 다시 만들어지면 이전 아이디어는 낡은 것이므로 상태를 되돌린다
    meta.status = "brief_draft";
    meta.extraSteps = brief.reviewStatus === "비대상" ? [] : ["카피 사전 점검 (아이디어 확정 후)", "완성본 심의 (시안 선택 후)"];
    await this.saveMeta(meta);
  }

  async saveIdeas(id: string, ideas: IdeasDoc) {
    const meta = await this.getMeta(id);
    this.assertNotLocked(meta);
    if (!(await this.getBrief(id))) throw new CaseError("브리프가 먼저 있어야 합니다");
    await this.store.write(id, "03_ideas.json", json(ideas));
    await this.store.write(id, "03_ideas.md", renderIdeasMarkdown(ideas, meta.company));
    meta.status = "ideas_draft";
    await this.saveMeta(meta);
  }

  /** 체크리스트 항목 확정 (게이트 1 전). 값이 비면 확정 취소 */
  async decide(id: string, rowId: string, value: string, by: string): Promise<BriefDoc> {
    const meta = await this.getMeta(id);
    this.assertNotLocked(meta);
    const brief = await this.getBrief(id);
    if (!brief) throw new CaseError("브리프가 없습니다");
    if (!brief.checklist.some((c) => c.id === rowId)) throw new CaseError("확정할 항목이 아닙니다");
    const v = value.trim();
    const who = by.trim();
    if (!who) throw new CaseError("확정한 사람 이름이 필요합니다");
    if (!v) delete brief.decisions[rowId];
    else brief.decisions[rowId] = { value: v, decidedBy: who, decidedAt: new Date().toISOString() };
    // 사람이 목적을 확정하면 방향표 행도 그 목적을 따른다 ("목적: 매출" 처럼 첫 번째로 나온 목적)
    if (rowId === "objective" && v) {
      const hits = OBJECTIVE_CATEGORIES.map((c) => ({ c, i: v.indexOf(c) }))
        .filter((x) => x.i >= 0)
        .sort((a, b) => a.i - b.i);
      if (hits.length) {
        brief.objectiveCategory = hits[0].c;
        brief.objectiveEstimated = false;
      }
    }
    brief.checklist = buildChecklist(brief);
    await this.store.write(id, "02_brief.json", json(brief));
    await this.store.write(id, "02_brief.md", renderBriefMarkdown(brief, meta.company));
    await this.saveMeta(meta);
    return brief;
  }

  /* ---------------- 게이트 1 ---------------- */

  async gate1Readiness(id: string, ideaId?: string): Promise<Gate1Readiness> {
    const blockers: string[] = [];
    const brief = await this.getBrief(id);
    const ideas = await this.getIdeas(id);
    if (!brief) blockers.push("브리프가 없습니다");
    else {
      const open = unresolved(brief);
      if (open.length) blockers.push(`확정하지 않은 항목 ${open.length}개: ${open.map((c) => c.label).join(", ")}`);
    }
    if (!ideas) blockers.push("아이디어 3안이 없습니다");
    else if (brief && ideas.generatedAt < brief.generatedAt) blockers.push("브리프가 아이디어보다 새롭습니다. 아이디어를 다시 만드세요");
    else if (brief && ideas.objectiveCategory !== brief.objectiveCategory)
      blockers.push(`확정한 목적(${brief.objectiveCategory})과 아이디어의 목적(${ideas.objectiveCategory})이 다릅니다. 아이디어를 다시 만드세요`);
    if (ideaId !== undefined && !ideas?.ideas.some((x) => x.id === ideaId)) blockers.push("아이디어 1안을 골라야 합니다");
    return { ok: blockers.length === 0, blockers };
  }

  async approveGate1(id: string, ideaId: string, approver: string, note = ""): Promise<CaseMeta> {
    const meta = await this.getMeta(id);
    this.assertNotLocked(meta);
    if (!approver.trim()) throw new CaseError("승인자 이름이 필요합니다");
    const r = await this.gate1Readiness(id, ideaId);
    if (!r.ok) throw new CaseError(`게이트 1을 통과할 수 없습니다: ${r.blockers.join(" / ")}`);
    const brief = (await this.getBrief(id))!;
    const ideas = (await this.getIdeas(id))!;
    ideas.selectedId = ideaId as IdeasDoc["selectedId"];
    const chosen = ideas.ideas.find((x) => x.id === ideaId)!;
    const now = new Date().toISOString();

    // 테스트 아이디어 항목을 실제 3안으로 채운다
    const t = brief.rows.find((r) => r.id === "testIdeas");
    if (t) t.content = ideas.ideas.map((x) => `${x.id.replace("idea-", "")}안 ${x.title}: ${x.headlines[0]} / ${x.visual.scene}`).join("<br>");

    await this.store.write(id, "02_brief.json", json(brief));
    await this.store.write(id, "02_brief.md", renderBriefMarkdown(brief, meta.company, { final: true }));
    await this.store.write(id, "03_ideas.json", json(ideas));
    await this.store.write(id, "03_ideas.md", renderIdeasMarkdown(ideas, meta.company));

    const decided = Object.keys(brief.decisions).length;
    const what = `아이디어 ${ideaId.replace("idea-", "")}안 "${chosen.title}" 선택, 브리프 확정(확정 항목 ${decided}개)${note.trim() ? `. 메모: ${note.trim()}` : ""}`;
    await this.store.append(id, "approvals.md", `| ${now} | 게이트 1 | ${approver.trim().replace(/\|/g, "/")} | ${what.replace(/\|/g, "/")} |\n`);

    meta.status = "gate1_approved";
    await this.saveMeta(meta);
    return meta;
  }

  /* ---------------- 내보내기·가져오기 ---------------- */

  async exportCase(id: string): Promise<CaseBundle> {
    await this.getMeta(id);
    const files: Record<string, string> = {};
    for (const name of await this.store.listFiles(id)) {
      const c = await this.store.read(id, name);
      if (c !== null) files[name] = c;
    }
    return { format: "ad-agent-case", version: 1, exportedAt: new Date().toISOString(), caseId: id, files };
  }

  /** 받은 케이스 파일을 가져온다. 같은 id가 있으면 새 id를 붙인다 */
  async importCase(raw: unknown): Promise<CaseMeta> {
    const b = raw as Partial<CaseBundle>;
    if (!b || b.format !== "ad-agent-case" || b.version !== 1 || typeof b.files !== "object" || !b.files) {
      throw new CaseError("케이스 파일 형식이 아닙니다");
    }
    const files = b.files as Record<string, unknown>;
    for (const [name, content] of Object.entries(files)) {
      if (!FILE_NAME_RE.test(name) || name.startsWith(".") || typeof content !== "string") throw new CaseError(`잘못된 파일: ${name}`);
    }
    if (typeof files["00_case.json"] !== "string" || typeof files["01_intake.json"] !== "string") throw new CaseError("필수 파일(00_case.json, 01_intake.json)이 없습니다");
    const meta = JSON.parse(files["00_case.json"] as string) as CaseMeta;
    IntakeSchema.parse(JSON.parse(files["01_intake.json"] as string)); // 형식 검사
    const id = await this.freeId(CASE_ID_RE.test(meta.id) ? meta.id : `${slug(meta.company ?? "case")}_${ymd()}`);
    meta.id = id;
    for (const [name, content] of Object.entries(files)) if (name !== "00_case.json") await this.store.write(id, name, content as string);
    await this.store.write(id, "00_case.json", json(meta));
    return meta;
  }

  async deleteCase(id: string) {
    await this.getMeta(id);
    await this.store.removeCase(id);
  }
}
