/**
 * 실제 Claude API로 가상 광고주(동네 수제 쿠키 가게) 1단계를 끝까지 돌린다.
 * 필요: llm.backend 가 "claude-cli"면 로그인된 claude CLI, "api"면 .env.local 의 ANTHROPIC_API_KEY
 * 실행: npm run demo:cookie
 * 결과: cases/달빛쿠키_YYYYMMDD/ (02_brief.md, 03_ideas.md, llm_log.jsonl)
 */
import fs from "node:fs";
import path from "node:path";

// .env.local 읽기 (값은 출력하지 않는다)
const envFile = path.resolve(".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const { loadSettings } = await import("../src/core/settings");
const backend = process.env.AD_AGENT_LLM_BACKEND ?? loadSettings().llm.backend;
console.log(`LLM 백엔드: ${backend}`);
if (backend === "api" && !process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY 가 없습니다. .env.local 에 넣어 주세요.");
  process.exit(1);
}

const { createCase } = await import("../src/core/case");
const { generateBrief, generateIdeas } = await import("../src/llm/pipeline");
const { renderTag } = await import("../src/core/tags");
const intake = JSON.parse(fs.readFileSync("tests/fixtures/cookie-intake.json", "utf8"));
intake.submittedAt = new Date().toISOString();

const meta = createCase(intake);
console.log(`케이스: ${meta.id}`);
const brief = await generateBrief(meta.id);
console.log(`브리프: 목적 ${brief.objectiveCategory}${brief.objectiveEstimated ? "(추정)" : ""}, 확정할 항목 ${brief.checklist.length}개, 검증 문제 ${brief.issues.length}개`);
for (const i of brief.issues) console.log(`  - [${i.severity}] ${i.where}: ${i.message}`);
const ideas = await generateIdeas(meta.id);
for (const x of ideas.ideas) console.log(`아이디어 ${x.id}: ${x.direction} / ${x.title} ${x.tags.map(renderTag).join(" ")} / 근거 ${x.evidenceStatus}`);
for (const i of ideas.issues) console.log(`  - [${i.severity}] ${i.where}: ${i.message}`);

// 규칙 점검 요약: "모르겠음" 질문(2, 3, 8, 11번)에서 온 항목에 [추정]이 붙었는지
const mustEstimate = ["objective", "target", "media"];
const missing = mustEstimate.filter((id) => !brief.rows.find((r) => r.id === id)?.tags.some((t) => t.kind === "estimate"));
const untagged = brief.rows.filter((r) => r.tags.length === 0).map((r) => r.id);
console.log(missing.length || untagged.length ? `규칙 위반: 추정 누락 ${missing.join(",")} / 태그 없음 ${untagged.join(",")}` : "규칙 점검 통과: 모든 행에 태그, 모르겠음 항목에 [추정]");
console.log(`다음: npm run dev 후 /console/${encodeURIComponent(meta.id)} 에서 확정 항목 처리와 게이트 1 승인`);
