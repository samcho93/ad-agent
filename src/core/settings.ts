import fs from "node:fs";
import path from "node:path";

export interface Settings {
  llm: {
    /** "claude-cli": 로그인된 Claude Code CLI 사용 (키 불필요). "api": Anthropic API 키 사용 */
    backend: "claude-cli" | "api";
    cliPath?: string;
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    maxTokens: number;
  };
  casesDir: string;
  revision: { includedCount: string | number; includedCountRange: string };
  pricing: string;
  privacyRetention: string;
  imageModel: string;
  defaultVariants: number;
  composeBackend: string;
}

export const PROJECT_ROOT = process.env.AD_AGENT_ROOT ?? process.cwd();

let cached: Settings | null = null;

export function loadSettings(): Settings {
  if (cached) return cached;
  const file = path.join(PROJECT_ROOT, "config", "settings.json");
  cached = JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  return cached;
}

export function casesRoot(): string {
  return process.env.AD_AGENT_CASES_DIR ?? path.join(PROJECT_ROOT, loadSettings().casesDir);
}

/** 스킬 파일(SKILL.md)의 본문. 프롬프트의 단일 원본이다. */
export function readSkill(name: string): string {
  const file = path.join(PROJECT_ROOT, ".claude", "skills", name, "SKILL.md");
  return fs.readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "");
}
