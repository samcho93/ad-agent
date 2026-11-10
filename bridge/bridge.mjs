#!/usr/bin/env node
/**
 * 광고 시안 에이전트 — Claude CLI 브리지
 *
 * 웹 앱(브라우저)이 이 PC의 Claude Code CLI로 생성을 맡길 수 있게 하는 작은 로컬 서버.
 * 의존성 없음. Node 18 이상.
 *
 *   node bridge.mjs                 # 기본 포트 8787
 *   node bridge.mjs --port 8790
 *   node bridge.mjs --origin https://example.github.io   # 허용할 웹 주소 추가
 *   node bridge.mjs --new-code      # 연결 코드 새로 만들기
 *   node bridge.mjs --config <파일>  # 연결 코드 저장 위치 (기본: ~/.ad-agent-bridge.json)
 *
 * 보안
 * - 127.0.0.1 에만 열린다 (다른 PC에서 접속 불가).
 * - 허용 목록의 웹 주소(Origin)에서 온 요청만 받는다. Host 헤더도 확인한다 (DNS 리바인딩 방지).
 * - 연결 코드(Bearer)가 맞아야 한다. 코드는 ~/.ad-agent-bridge.json 에 저장된다.
 * - 할 수 있는 일은 하나뿐: 받은 프롬프트(와 검수용 이미지)와 JSON 스키마로 `claude -p` 를 실행해 구조화된 결과를 돌려준다.
 *   도구는 모두 끈 상태(--tools "")로 실행하고, 임의 명령은 실행하지 않는다.
 * - 프롬프트와 결과는 기록하지 않는다. 요청 시각, 경로, 상태 코드만 화면에 찍는다.
 */
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "0.2.1";
const DEFAULT_ORIGINS = [
  "https://samcho93.github.io",
  "https://ad-agent-4k9.pages.dev", // Cloudflare Pages
  "https://irodmas.com", // SamStudy 허브 (irodmas.com/<강좌>/)
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];
const MAX_BODY = 48 * 1024 * 1024; // 검수용 이미지 포함
const MAX_IMAGES = 12;
const MAX_IMAGE_B64 = 8 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 10 * 60 * 1000;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_RE = /^claude-[a-z0-9.-]{1,60}$/;

/* ---------------- 인자 ---------------- */

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const allOpts = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("사용법: node bridge.mjs [--port 8787] [--origin <웹 주소>]... [--claude <claude 경로>] [--config <파일>] [--new-code]");
  process.exit(0);
}

const PORT = Number(opt("--port") ?? process.env.AD_AGENT_BRIDGE_PORT ?? 8787);
const ORIGINS = new Set([...DEFAULT_ORIGINS, ...allOpts("--origin").map((o) => o.replace(/\/+$/, ""))]);

/* ---------------- 연결 코드 ---------------- */

const CONFIG_FILE = opt("--config") ?? path.join(os.homedir(), ".ad-agent-bridge.json");

function loadOrCreateCode() {
  if (!argv.includes("--new-code")) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      if (typeof c.code === "string" && c.code.length >= 24) return c.code;
    } catch {
      /* 없으면 새로 만든다 */
    }
  }
  const code = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ code, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return code;
}
const CODE = loadOrCreateCode();
const CODE_BUF = Buffer.from(CODE);

function codeOk(header) {
  const m = /^Bearer\s+(.+)$/.exec(header ?? "");
  if (!m) return false;
  const given = Buffer.from(m[1].trim());
  return given.length === CODE_BUF.length && crypto.timingSafeEqual(given, CODE_BUF);
}

/* ---------------- claude 실행 파일 찾기 ---------------- */

function resolveClaude() {
  const configured = opt("--claude") ?? process.env.AD_AGENT_CLAUDE_BIN;
  if (configured) return configured;
  if (process.platform !== "win32") return "claude";
  // Windows의 npm 설치본은 claude.cmd 셔임이라, shell 없이 실행하려고 실제 exe를 찾는다
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const exe = path.join(dir, "claude.exe");
    if (fs.existsSync(exe)) return exe;
    if (fs.existsSync(path.join(dir, "claude.cmd"))) {
      const shimExe = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (fs.existsSync(shimExe)) return shimExe;
    }
  }
  const local = path.join(os.homedir(), ".local", "bin", "claude.exe");
  if (fs.existsSync(local)) return local;
  return null;
}
const CLAUDE = resolveClaude();

let claudeVersion = "확인 안 됨";
if (CLAUDE) {
  execFile(CLAUDE, ["--version"], { windowsHide: true, timeout: 20000 }, (err, out) => {
    if (!err) claudeVersion = String(out).trim();
  });
}

/* ---------------- 생성 ---------------- */

function runClaude({ system, user, jsonSchema, model, effort, images }) {
  const withImages = Array.isArray(images) && images.length > 0;
  return new Promise((resolve, reject) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ad-agent-bridge-"));
    const sysFile = path.join(work, "system.md");
    fs.writeFileSync(sysFile, system, "utf8");
    const args = [
      "-p",
      // 이미지가 있으면 stream-json 으로 이미지 블록을 함께 넘긴다 (마지막 줄이 result 이벤트)
      ...(withImages ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
      "--json-schema", JSON.stringify(jsonSchema),
      "--system-prompt-file", sysFile,
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", model,
      "--effort", effort,
    ];
    // 프로젝트 CLAUDE.md 등이 섞이지 않게 빈 임시 폴더에서 실행한다
    const child = spawn(CLAUDE, args, { cwd: work, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const cleanup = () => fs.rmSync(work, { recursive: true, force: true });
    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new Error("claude CLI 응답 시간 초과 (10분)"));
    }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`claude CLI 실행 실패: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      let out;
      try {
        const lines = stdout.trim().split(/\r?\n/);
        const last = withImages ? [...lines].reverse().find((l) => l.includes('"type":"result"')) : lines.pop();
        out = JSON.parse(last ?? "");
      } catch {
        return reject(new Error(`claude CLI 출력을 읽지 못했습니다 (종료 코드 ${code}): ${(stderr || stdout).slice(0, 300)}`));
      }
      if (out.is_error || out.subtype !== "success") {
        return reject(new Error(`claude CLI 오류 (${out.subtype ?? "unknown"}${out.api_error_status ? `, ${out.api_error_status}` : ""}): ${String(out.result ?? stderr).slice(0, 300)}`));
      }
      if (out.stop_reason === "refusal") return reject(new Error("모델이 요청을 거절했습니다"));
      const u = out.usage ?? {};
      resolve({
        structured_output: out.structured_output,
        model: Object.keys(out.modelUsage ?? {})[0] ?? model,
        stop_reason: out.stop_reason ?? null,
        usage: {
          input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          output_tokens: u.output_tokens ?? 0,
        },
        cost_usd: out.total_cost_usd,
        images_seen: withImages ? images.length : 0,
      });
    });
    if (withImages) {
      const content = [
        ...images.flatMap((im) => [
          { type: "text", text: im.label },
          { type: "image", source: { type: "base64", media_type: im.mime, data: im.base64 } },
        ]),
        { type: "text", text: user },
      ];
      child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", "utf8");
    } else child.stdin.end(user, "utf8");
  });
}

function validateGenerate(b) {
  if (!b || typeof b !== "object") return "요청 형식이 아닙니다";
  if (typeof b.system !== "string" || b.system.length > 400_000) return "system 이 없거나 너무 깁니다";
  if (typeof b.user !== "string" || !b.user || b.user.length > 1_000_000) return "user 가 없거나 너무 깁니다";
  if (!b.jsonSchema || typeof b.jsonSchema !== "object" || Array.isArray(b.jsonSchema)) return "jsonSchema 가 없습니다";
  if (typeof b.model !== "string" || !MODEL_RE.test(b.model)) return "model 형식이 올바르지 않습니다";
  if (!EFFORTS.has(b.effort)) return "effort 값이 올바르지 않습니다";
  if (b.images !== undefined) {
    if (!Array.isArray(b.images) || b.images.length > MAX_IMAGES) return `images 는 ${MAX_IMAGES}개 이하 배열이어야 합니다`;
    for (const im of b.images) {
      if (!im || typeof im.label !== "string" || im.label.length > 1000) return "이미지 label 이 올바르지 않습니다";
      if (!IMAGE_MIMES.has(im.mime)) return "이미지 형식은 png, jpeg, webp 만 됩니다";
      if (typeof im.base64 !== "string" || im.base64.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+=*$/.test(im.base64)) return "이미지 데이터가 올바르지 않습니다";
    }
  }
  return null;
}

/* ---------------- HTTP ---------------- */

let running = 0;

function send(res, status, body, origin) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", vary: "Origin" };
  if (origin) headers["access-control-allow-origin"] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("요청이 너무 큽니다"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const log = (req, status, started) =>
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}  ${status}  ${Date.now() - started}ms`);

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const origin = req.headers.origin;
  const allowedOrigin = origin && ORIGINS.has(origin) ? origin : null;

  // DNS 리바인딩 방지: Host 는 이 PC 주소여야 한다
  const host = String(req.headers.host ?? "");
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) {
    send(res, 403, { error: "허용되지 않은 Host" });
    return log(req, 403, started);
  }
  // 브라우저 요청은 허용 목록의 웹 주소에서 온 것만 받는다 (Origin 이 없는 요청은 curl 등 로컬 도구)
  if (origin && !allowedOrigin) {
    send(res, 403, { error: `허용되지 않은 웹 주소: ${origin} (브리지 실행 시 --origin 으로 추가)` });
    return log(req, 403, started);
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": allowedOrigin ?? "",
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "authorization, content-type",
      // 공개 웹사이트 → 로컬 주소 요청 허용 (Chrome Private Network Access)
      "access-control-allow-private-network": "true",
      "access-control-max-age": "600",
      vary: "Origin",
    });
    res.end();
    return log(req, 204, started);
  }

  if (!codeOk(req.headers.authorization)) {
    send(res, 401, { error: "연결 코드가 맞지 않습니다" }, allowedOrigin);
    return log(req, 401, started);
  }

  try {
    if (req.method === "GET" && req.url === "/v1/health") {
      send(res, 200, { ok: true, version: VERSION, features: ["images"], claude: CLAUDE ? `claude ${claudeVersion}` : "claude CLI 없음" }, allowedOrigin);
      return log(req, 200, started);
    }
    if (req.method === "POST" && req.url === "/v1/generate") {
      if (!CLAUDE) {
        send(res, 500, { error: "claude CLI를 찾지 못했습니다 (--claude 로 경로 지정)" }, allowedOrigin);
        return log(req, 500, started);
      }
      if (running >= MAX_CONCURRENT) {
        send(res, 429, { error: "이미 생성 중인 작업이 있습니다. 잠시 후 다시 시도하세요" }, allowedOrigin);
        return log(req, 429, started);
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        send(res, 400, { error: e instanceof Error ? e.message : "JSON이 아닙니다" }, allowedOrigin);
        return log(req, 400, started);
      }
      const bad = validateGenerate(body);
      if (bad) {
        send(res, 400, { error: bad }, allowedOrigin);
        return log(req, 400, started);
      }
      running++;
      try {
        const out = await runClaude(body);
        send(res, 200, out, allowedOrigin);
        return log(req, 200, started);
      } finally {
        running--;
      }
    }
    send(res, 404, { error: "없는 경로" }, allowedOrigin);
    return log(req, 404, started);
  } catch (e) {
    send(res, 502, { error: e instanceof Error ? e.message : "오류" }, allowedOrigin);
    return log(req, 502, started);
  }
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `포트 ${PORT} 를 이미 쓰고 있습니다. --port 로 다른 포트를 지정하세요.` : e.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log(`  광고 시안 에이전트 — Claude CLI 브리지 ${VERSION}`);
  console.log(`  주소:      http://127.0.0.1:${PORT}`);
  console.log(`  연결 코드: ${CODE}`);
  console.log(`  claude:    ${CLAUDE ?? "찾지 못함 (--claude <경로>)"}`);
  console.log(`  허용 웹:   ${[...ORIGINS].join(", ")}`);
  console.log("");
  console.log("  웹 앱의 설정 > LLM 연결 > Claude CLI 브리지 에 주소와 연결 코드를 넣으세요.");
  console.log("  끝내려면 Ctrl+C");
  console.log("");
});
