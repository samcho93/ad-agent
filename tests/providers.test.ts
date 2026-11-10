import { afterEach, describe, expect, it, vi } from "vitest";
import { BriefModelOutput } from "@/core/brief";
import { IdeaModelOutput } from "@/core/ideas";
import { mergeSettings, currentModel } from "@/core/settings";
import { parseJsonOutput, toStrictJsonSchema } from "@/llm/jsonSchema";
import { createOpenAIGenerator } from "@/llm/openaiGenerator";
import { createGeminiGenerator } from "@/llm/geminiGenerator";
import { createGenerator } from "@/llm/select";
import { DEFAULT_SETTINGS } from "@/core/settings";
import { goodBrief } from "@/llm/fake";

type Node = Record<string, unknown>;
function walkObjects(n: unknown, visit: (o: Node) => void) {
  if (Array.isArray(n)) return n.forEach((x) => walkObjects(x, visit));
  if (!n || typeof n !== "object") return;
  const o = n as Node;
  if (o.type === "object") visit(o);
  Object.values(o).forEach((v) => walkObjects(v, visit));
}

describe("JSON 스키마 변환 (OpenAI strict 요건)", () => {
  for (const [name, schema] of [["brief", BriefModelOutput], ["ideas", IdeaModelOutput]] as const) {
    it(`${name}: 모든 object 가 닫혀 있고 모든 속성이 required`, () => {
      const js = toStrictJsonSchema(schema);
      expect(js.$schema).toBeUndefined();
      let count = 0;
      walkObjects(js, (o) => {
        count++;
        expect(o.additionalProperties).toBe(false);
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as Node).sort());
      });
      expect(count).toBeGreaterThan(1);
    });
  }

  it("코드 블록으로 감싼 JSON도 읽고, 스키마가 다르면 거부한다", () => {
    const data = goodBrief();
    expect(parseJsonOutput(BriefModelOutput, "```json\n" + JSON.stringify(data) + "\n```").client.content).toBe(data.client.content);
    expect(() => parseJsonOutput(BriefModelOutput, '{"client": 1}')).toThrow(/스키마/);
    expect(() => parseJsonOutput(BriefModelOutput, "not json")).toThrow(/JSON/);
  });
});

describe("설정", () => {
  it("예전 형식(llm.model)을 연결 방식별 모델로 옮긴다", () => {
    const s = mergeSettings({ llm: { provider: "bridge", model: "claude-opus-5-5", effort: "high", maxTokens: 1000, bridgeUrl: "http://127.0.0.1:8787" } } as never);
    expect(s.llm.models.bridge).toBe("claude-opus-5-5");
    expect((s.llm as Record<string, unknown>).model).toBeUndefined();
    expect(currentModel(s)).toBe("claude-opus-5-5");
  });

  it("모델을 고르지 않았으면 생성을 시작하지 않는다", () => {
    const s = mergeSettings({ llm: { ...DEFAULT_SETTINGS.llm, provider: "openai" } });
    expect(currentModel(s)).toBe("");
    expect(() => createGenerator(s, { openaiApiKey: "test" })).toThrow(/모델을 고르세요/);
  });
});

describe("요청 형태 (네트워크는 가짜로 대체)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("OpenAI: Responses API + strict json_schema, 추론 모델에만 reasoning", async () => {
    const calls: { url: string; body: Node }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          id: "resp_1", object: "response", created_at: 0, status: "completed", model: "test-model",
          output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(goodBrief()), annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const gen = createOpenAIGenerator({ apiKey: "test-key", model: "gpt-5-test", effort: "high", maxTokens: 5000 });
    const res = await gen({ purpose: "brief", system: "SYS", user: "USER", schema: BriefModelOutput });
    expect(res.data.client.content).toBe(goodBrief().client.content);
    expect(calls[0].url).toContain("/responses");
    const b = calls[0].body as { instructions: string; input: string; reasoning?: unknown; text: { format: { type: string; strict: boolean } } };
    expect(b.instructions).toBe("SYS");
    expect(b.input).toBe("USER");
    expect(b.text.format.type).toBe("json_schema");
    expect(b.text.format.strict).toBe(true);
    expect(b.reasoning).toEqual({ effort: "high" });

    const gen2 = createOpenAIGenerator({ apiKey: "test-key", model: "gpt-4o", effort: "high", maxTokens: 5000 });
    await gen2({ purpose: "brief", system: "SYS", user: "USER", schema: BriefModelOutput });
    expect((calls[1].body as Node).reasoning).toBeUndefined();
  });

  it("Gemini: JSON 출력 + responseJsonSchema + 시스템 지시, 잘리면 오류", async () => {
    const bodies: Node[] = [];
    let finish = "STOP";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(goodBrief()) }] }, finishReason: finish }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
          modelVersion: "gemini-test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const gen = createGeminiGenerator({ apiKey: "test-key", model: "gemini-3-test", effort: "medium", maxTokens: 5000 });
    const res = await gen({ purpose: "brief", system: "SYS", user: "USER", schema: BriefModelOutput });
    expect(res.data.client.content).toBe(goodBrief().client.content);
    const cfg = bodies[0].generationConfig as Node;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseJsonSchema).toBeTruthy();
    expect(JSON.stringify(bodies[0].systemInstruction)).toContain("SYS");
    expect(JSON.stringify(cfg.thinkingConfig)).toContain("MEDIUM");

    finish = "MAX_TOKENS";
    await expect(gen({ purpose: "brief", system: "SYS", user: "USER", schema: BriefModelOutput })).rejects.toThrow(/최대 토큰/);
  });
});
