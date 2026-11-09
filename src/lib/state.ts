import { getBrief, getIdeas, getIntake, getMeta, gate1Readiness, readApprovals } from "@/core/case";
import { unresolved } from "@/core/brief";
import { unknownQuestions } from "@/core/intake";
import { loadSettings } from "@/core/settings";

/** 콘솔 화면에 필요한 상태. 담당자 연락처는 화면에 그대로 보낸다(내부 콘솔). API 키는 절대 포함하지 않는다. */
export function caseState(id: string) {
  const meta = getMeta(id);
  const intake = getIntake(id);
  const brief = getBrief(id);
  const ideas = getIdeas(id);
  return {
    meta,
    intake,
    unknowns: unknownQuestions(intake),
    brief,
    ideas,
    openCount: brief ? unresolved(brief).length : null,
    readiness: gate1Readiness(id),
    approvals: readApprovals(id),
    settings: { model: loadSettings().llm.model, revision: loadSettings().revision.includedCount },
  };
}

export type CaseState = ReturnType<typeof caseState>;
