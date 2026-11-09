// API 키 없이 화면을 시험하는 개발 서버. 가짜 모델(쿠키 가게 응답)을 쓰고, 케이스는 cases-fake/ 에 저장한다.
import { spawn } from "node:child_process";
import path from "node:path";

const env = { ...process.env, AD_AGENT_FAKE_LLM: "1", AD_AGENT_CASES_DIR: path.resolve("cases-fake") };
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", process.env.PORT ?? "3001"], { env, stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
