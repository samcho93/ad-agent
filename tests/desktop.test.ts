import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { mergeSettings, currentModel, DEFAULT_SETTINGS } from "@/core/settings";
import { createDesktopGenerator, checkDesktop, isDesktopApp } from "@/llm/desktopGenerator";
import { createGenerator, checkConnection } from "@/llm/select";
// @ts-expect-error 브리지는 의존성 없는 .mjs (타입 없음)
import * as bridge from "../bridge/bridge.mjs";

const Out = z.object({ title: z.string(), n: z.number() });
const g = globalThis as { adAgentDesktop?: unknown };

/** 데스크톱 앱의 preload 창구 흉내 */
function mockDesktop(result: Record<string, unknown> | { error: string }) {
  const calls: Record<string, unknown>[] = [];
  g.adAgentDesktop = {
    version: 1,
    claude: {
      check: async (p: string) => ({ ok: true, path: p || "C:/x/claude.exe", version: "2.1.0 (Claude Code)", core: "0.3.0" }),
      generate: async (req: Record<string, unknown>) => {
        calls.push(req);
        return "error" in result ? { ok: false, error: result.error } : { ok: true, result };
      },
    },
  };
  return calls;
}

afterEach(() => {
  delete g.adAgentDesktop;
});

describe("데스크톱: 이 PC의 Claude CLI (브리지 없이)", () => {
  it("웹판에서는 쓸 수 없다고 알린다", async () => {
    expect(isDesktopApp()).toBe(false);
    const gen = createDesktopGenerator({ model: "claude-opus-5-5", effort: "high", claudePath: "" });
    await expect(gen({ purpose: "brief", system: "s", user: "u", schema: Out })).rejects.toThrow(/데스크톱 실행파일에서만/);
  });

  it("설정 기본값: 모델은 브리지와 같고, 키 없이 연결 확인한다", async () => {
    const s = mergeSettings({ llm: { ...DEFAULT_SETTINGS.llm, provider: "desktop" } });
    expect(currentModel(s)).toBe("claude-opus-5-5");
    expect(s.llm.claudePath).toBe("");
    mockDesktop({});
    expect(isDesktopApp()).toBe(true);
    const r = await checkConnection(s, "");
    expect(r.message).toContain("연결됨 (2.1.0");
    expect(await checkDesktop("C:/a/claude.exe")).toContain("C:/a/claude.exe");
  });

  it("브리지와 같은 요청을 보내고, 결과를 스키마로 다시 검증한다", async () => {
    const calls = mockDesktop({ structured_output: { title: "안녕", n: 3 }, model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, cost_usd: 0.01, images_seen: 0 });
    const s = mergeSettings({ llm: { ...DEFAULT_SETTINGS.llm, provider: "desktop", claudePath: "C:/me/claude.exe" } });
    const gen = createGenerator(s, {});
    const r = await gen({ purpose: "brief", system: "시스템", user: "사용자", schema: Out });
    expect(r).toMatchObject({ data: { title: "안녕", n: 3 }, model: "claude-opus-5-5 (claude-cli)", usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.01 });
    expect(calls[0]).toMatchObject({ system: "시스템", user: "사용자", model: "claude-opus-5-5", effort: "high", claudePath: "C:/me/claude.exe" });
    expect((calls[0].jsonSchema as { properties: object }).properties).toHaveProperty("title");
  });

  it("오류·스키마 불일치·이미지 누락은 생성 오류로", async () => {
    mockDesktop({ error: "이 PC에서 claude(Claude Code CLI)를 찾지 못했습니다" });
    const gen = createDesktopGenerator({ model: "claude-opus-5-5", effort: "high", claudePath: "" });
    await expect(gen({ purpose: "brief", system: "s", user: "u", schema: Out })).rejects.toThrow(/찾지 못했습니다/);

    mockDesktop({ structured_output: { title: 1 } });
    await expect(gen({ purpose: "brief", system: "s", user: "u", schema: Out })).rejects.toThrow(/스키마와 다릅니다/);

    mockDesktop({ structured_output: { title: "a", n: 1 }, images_seen: 0 });
    const img = { label: "시안 A", mime: "image/png" as const, base64: "AAAA" };
    await expect(gen({ purpose: "qa", system: "s", user: "u", schema: Out, images: [img] })).rejects.toThrow(/이미지를 함께 넘기지 못했습니다/);
  });
});

describe("브리지 공용 코드 (데스크톱 앱이 그대로 불러 씀)", () => {
  it("불러오기만 하면 서버를 열지 않고 실행 함수만 내보낸다", () => {
    expect(Object.keys(bridge).sort()).toEqual(["VERSION", "claudeVersion", "resolveClaude", "runClaude", "validateGenerate"]);
    expect(bridge.VERSION).toBe("0.3.0");
    expect(bridge.resolveClaude("C:/given/claude.exe")).toBe("C:/given/claude.exe");
  });

  it("요청 검사: 모델 이름·추론 강도·이미지 형식", () => {
    const ok = { system: "s", user: "u", jsonSchema: { type: "object" }, model: "claude-opus-5-5", effort: "high" };
    expect(bridge.validateGenerate(ok)).toBeNull();
    expect(bridge.validateGenerate({ ...ok, model: "gpt-5; rm -rf /" })).toMatch(/model/);
    expect(bridge.validateGenerate({ ...ok, effort: "turbo" })).toMatch(/effort/);
    expect(bridge.validateGenerate({ ...ok, images: [{ label: "a", mime: "image/gif", base64: "AAAA" }] })).toMatch(/png, jpeg, webp/);
  });
});
