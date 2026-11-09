import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod/v4";
import { loadSettings } from "@/core/settings";
import { GenerationError, type Generator } from "./generator";

/**
 * Claude Code CLI(`claude -p`)로 구조화된 출력을 받는 생성기.
 * 로그인된 Claude Code 계정을 쓰므로 API 키가 필요 없다 (개발·시험용).
 * - 도구 없음(--tools ""), MCP 없음, 세션 저장 안 함
 * - 프로젝트 CLAUDE.md가 섞이지 않게 임시 폴더에서 실행
 * - 시스템 프롬프트는 SKILL.md 기반 프롬프트로 교체
 */

const TIMEOUT_MS = 10 * 60 * 1000;

/** Windows의 npm 설치본은 claude.cmd 셔임이라 shell 없이 실행하려면 실제 exe를 찾는다 */
function resolveClaudeBin(): string {
  const configured = process.env.AD_AGENT_CLAUDE_BIN ?? loadSettings().llm.cliPath;
  if (configured && configured !== "claude") return configured;
  if (process.platform !== "win32") return "claude";
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, "claude.exe");
    if (fs.existsSync(exe)) return exe;
    if (fs.existsSync(path.join(dir, "claude.cmd"))) {
      const shimExe = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (fs.existsSync(shimExe)) return shimExe;
    }
  }
  throw new GenerationError("claude CLI를 찾지 못했습니다 (config/settings.json 의 llm.cliPath 또는 AD_AGENT_CLAUDE_BIN 설정)");
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
  api_error_status?: number | null;
}

function run(bin: string, args: string[], stdin: string, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new GenerationError("claude CLI 응답 시간 초과 (10분)"));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new GenerationError(`claude CLI 실행 실패: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin, "utf8");
  });
}

export const claudeCliGenerator: Generator = async (req) => {
  const s = loadSettings().llm;
  const schema = z.toJSONSchema(req.schema, { target: "draft-7" });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ad-agent-cli-"));
  try {
    const sysFile = path.join(work, "system.md");
    fs.writeFileSync(sysFile, req.system, "utf8");
    const args = [
      "-p",
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--system-prompt-file", sysFile,
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", s.model,
      "--effort", s.effort,
    ];
    const { code, stdout, stderr } = await run(resolveClaudeBin(), args, req.user, work);
    let out: CliResult;
    try {
      out = JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "");
    } catch {
      throw new GenerationError(`claude CLI 출력을 읽지 못했습니다 (종료 코드 ${code}): ${stderr.slice(0, 300) || stdout.slice(0, 300)}`);
    }
    if (out.is_error || out.subtype !== "success") {
      throw new GenerationError(`claude CLI 오류 (${out.subtype ?? "unknown"}${out.api_error_status ? `, ${out.api_error_status}` : ""}): ${(out.result ?? stderr).slice(0, 300)}`);
    }
    if (out.stop_reason === "refusal") throw new GenerationError("모델이 요청을 거절했습니다");
    const parsed = req.schema.safeParse(out.structured_output);
    if (!parsed.success) throw new GenerationError(`모델 출력이 스키마와 다릅니다: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    const model = Object.keys(out.modelUsage ?? {})[0] ?? s.model;
    return {
      data: parsed.data,
      model: `${model} (claude-cli)`,
      stopReason: out.stop_reason ?? null,
      usage: {
        input_tokens: (out.usage?.input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0),
        output_tokens: out.usage?.output_tokens ?? 0,
      },
      costUsd: out.total_cost_usd,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
};
