/**
 * 스킬 파일(SKILL.md)을 빌드에 텍스트로 넣는다. 프롬프트의 단일 원본은 .claude/skills/ 이다.
 */
import adBrief from "../../.claude/skills/ad-brief/SKILL.md?raw";
import adIdeation from "../../.claude/skills/ad-ideation/SKILL.md?raw";
import adIntake from "../../.claude/skills/ad-intake/SKILL.md?raw";
import adImageRouter from "../../.claude/skills/ad-image-router/SKILL.md?raw";
import adQa from "../../.claude/skills/ad-qa/SKILL.md?raw";
import adRevise from "../../.claude/skills/ad-revise/SKILL.md?raw";

const SKILLS: Record<string, string> = {
  "ad-brief": adBrief,
  "ad-ideation": adIdeation,
  "ad-intake": adIntake,
  "ad-image-router": adImageRouter,
  "ad-qa": adQa,
  "ad-revise": adRevise,
};

export function readSkill(name: keyof typeof SKILLS | string): string {
  const raw = SKILLS[name];
  if (!raw) throw new Error(`스킬이 없습니다: ${name}`);
  return raw.replace(/^---[\s\S]*?---\s*/, "");
}
