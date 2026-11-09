import fs from "node:fs";
import path from "node:path";
import { casesRoot, loadSettings } from "./settings";
import { IntakeSchema, type Intake } from "./intake";
import { type BriefDoc, buildChecklist, renderBriefMarkdown, unresolved, OBJECTIVE_CATEGORIES } from "./brief";
import { type IdeasDoc, renderIdeasMarkdown } from "./ideas";

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
  /** 심의 업종이면 게이트 1 뒤에 "카피 사전 점검"이 추가된다 */
  extraSteps: string[];
}

export class CaseError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const ID_RE = /^[\p{L}\p{N}_-]{1,80}$/u;

export function caseDir(id: string): string {
  if (!ID_RE.test(id)) throw new CaseError("잘못된 케이스 id", 400);
  return path.join(casesRoot(), id);
}

const file = (id: string, name: string) => path.join(caseDir(id), name);
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, "utf8")) as T;
const writeJson = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");

function slug(company: string): string {
  return (
    company
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "case"
  );
}

function ymd(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/* ---------------- 생성·조회 ---------------- */

export function createCase(input: unknown): CaseMeta {
  const parsed = IntakeSchema.safeParse(input);
  if (!parsed.success) {
    throw new CaseError(`질문지 형식 오류: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const intake = parsed.data;
  fs.mkdirSync(casesRoot(), { recursive: true });
  const base = `${slug(intake.contact.company)}_${ymd()}`;
  let id = base;
  for (let n = 2; fs.existsSync(path.join(casesRoot(), id)); n++) id = `${base}-${n}`;
  const dir = path.join(casesRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const meta: CaseMeta = {
    id,
    company: intake.contact.company,
    createdAt: now,
    updatedAt: now,
    status: "intake_done",
    backend: loadSettings().composeBackend,
    extraSteps: [],
  };
  writeJson(path.join(dir, "00_case.json"), meta);
  writeJson(path.join(dir, "01_intake.json"), intake);
  fs.writeFileSync(path.join(dir, "approvals.md"), `# 승인 기록 — ${intake.contact.company}\n\n| 시각 | 게이트 | 승인자 | 내용 |\n|---|---|---|---|\n`, "utf8");
  fs.writeFileSync(path.join(dir, "revisions.md"), `# 수정 기록\n\n포함 수정 횟수: ${loadSettings().revision.includedCount}\n\n`, "utf8");
  return meta;
}

export function listCases(): CaseMeta[] {
  const root = casesRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, "00_case.json")))
    .map((d) => readJson<CaseMeta>(path.join(root, d.name, "00_case.json")))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getMeta(id: string): CaseMeta {
  const p = file(id, "00_case.json");
  if (!fs.existsSync(p)) throw new CaseError("케이스가 없습니다", 404);
  return readJson<CaseMeta>(p);
}

export function getIntake(id: string): Intake {
  return IntakeSchema.parse(readJson(file(id, "01_intake.json")));
}

export function getBrief(id: string): BriefDoc | null {
  const p = file(id, "02_brief.json");
  return fs.existsSync(p) ? readJson<BriefDoc>(p) : null;
}

export function getIdeas(id: string): IdeasDoc | null {
  const p = file(id, "03_ideas.json");
  return fs.existsSync(p) ? readJson<IdeasDoc>(p) : null;
}

function saveMeta(meta: CaseMeta) {
  meta.updatedAt = new Date().toISOString();
  writeJson(file(meta.id, "00_case.json"), meta);
}

function assertNotLocked(meta: CaseMeta) {
  if (meta.status === "gate1_approved") throw new CaseError("게이트 1이 승인된 케이스는 브리프·아이디어를 바꿀 수 없습니다", 409);
}

/* ---------------- 저장 ---------------- */

export function saveBrief(id: string, brief: BriefDoc) {
  const meta = getMeta(id);
  assertNotLocked(meta);
  writeJson(file(id, "02_brief.json"), brief);
  fs.writeFileSync(file(id, "02_brief.md"), renderBriefMarkdown(brief, meta.company), "utf8");
  // 브리프가 다시 만들어지면 이전 아이디어는 낡은 것이므로 상태를 되돌린다
  meta.status = "brief_draft";
  meta.extraSteps = brief.reviewStatus === "비대상" ? [] : ["카피 사전 점검 (아이디어 확정 후)", "완성본 심의 (시안 선택 후)"];
  saveMeta(meta);
}

export function saveIdeas(id: string, ideas: IdeasDoc) {
  const meta = getMeta(id);
  assertNotLocked(meta);
  if (!getBrief(id)) throw new CaseError("브리프가 먼저 있어야 합니다", 409);
  writeJson(file(id, "03_ideas.json"), ideas);
  fs.writeFileSync(file(id, "03_ideas.md"), renderIdeasMarkdown(ideas, meta.company), "utf8");
  meta.status = "ideas_draft";
  saveMeta(meta);
}

/** 체크리스트 항목 확정 (게이트 1 전) */
export function decide(id: string, rowId: string, value: string, by: string): BriefDoc {
  const meta = getMeta(id);
  assertNotLocked(meta);
  const brief = getBrief(id);
  if (!brief) throw new CaseError("브리프가 없습니다", 409);
  if (!brief.checklist.some((c) => c.id === rowId)) throw new CaseError("확정할 항목이 아닙니다", 400);
  const v = value.trim();
  const who = by.trim();
  if (!who) throw new CaseError("확정한 사람 이름이 필요합니다", 400);
  if (!v) delete brief.decisions[rowId];
  else brief.decisions[rowId] = { value: v, decidedBy: who, decidedAt: new Date().toISOString() };
  // 사람이 목적을 확정하면 방향표 행도 그 목적을 따른다 ("목적: 매출" 처럼 첫 번째로 나온 목적)
  if (rowId === "objective" && v) {
    const hits = OBJECTIVE_CATEGORIES.map((c) => ({ c, i: v.indexOf(c) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    if (hits.length) {
      brief.objectiveCategory = hits[0].c;
      brief.objectiveEstimated = false;
    }
  }
  brief.checklist = buildChecklist(brief);
  writeJson(file(id, "02_brief.json"), brief);
  fs.writeFileSync(file(id, "02_brief.md"), renderBriefMarkdown(brief, meta.company), "utf8");
  saveMeta(meta);
  return brief;
}

/* ---------------- 게이트 1 ---------------- */

export interface Gate1Readiness {
  ok: boolean;
  blockers: string[];
}

export function gate1Readiness(id: string, ideaId?: string): Gate1Readiness {
  const blockers: string[] = [];
  const brief = getBrief(id);
  const ideas = getIdeas(id);
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

export function approveGate1(id: string, ideaId: string, approver: string, note = ""): CaseMeta {
  const meta = getMeta(id);
  assertNotLocked(meta);
  if (!approver.trim()) throw new CaseError("승인자 이름이 필요합니다", 400);
  const r = gate1Readiness(id, ideaId);
  if (!r.ok) throw new CaseError(`게이트 1을 통과할 수 없습니다: ${r.blockers.join(" / ")}`, 409);
  const brief = getBrief(id)!;
  const ideas = getIdeas(id)!;
  ideas.selectedId = ideaId as IdeasDoc["selectedId"];
  const chosen = ideas.ideas.find((x) => x.id === ideaId)!;
  const now = new Date().toISOString();

  // 테스트 아이디어 항목을 실제 3안으로 채운다
  const t = brief.rows.find((r) => r.id === "testIdeas");
  if (t) t.content = ideas.ideas.map((x) => `${x.id.replace("idea-", "")}안 ${x.title}: ${x.headlines[0]} / ${x.visual.scene}`).join("<br>");

  writeJson(file(id, "02_brief.json"), brief);
  fs.writeFileSync(file(id, "02_brief.md"), renderBriefMarkdown(brief, meta.company, { final: true }), "utf8");
  writeJson(file(id, "03_ideas.json"), ideas);
  fs.writeFileSync(file(id, "03_ideas.md"), renderIdeasMarkdown(ideas, meta.company), "utf8");

  const decided = Object.keys(brief.decisions).length;
  const what = `아이디어 ${ideaId.replace("idea-", "")}안 "${chosen.title}" 선택, 브리프 확정(확정 항목 ${decided}개)${note.trim() ? `. 메모: ${note.trim()}` : ""}`;
  fs.appendFileSync(file(id, "approvals.md"), `| ${now} | 게이트 1 | ${approver.trim().replace(/\|/g, "/")} | ${what.replace(/\|/g, "/")} |\n`, "utf8");

  meta.status = "gate1_approved";
  saveMeta(meta);
  return meta;
}

export function readApprovals(id: string): string {
  const p = file(id, "approvals.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}
