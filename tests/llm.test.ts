import { describe, expect, it } from "vitest";
import { QwenProvider } from "../src/llm/qwen.js";

describe("QwenProvider", () => {
  it("uses the injected endpoint and parses structured output", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = new QwenProvider({
      endpoint: "http://local.test/chat",
      model: "Qwen-local",
      fetchImpl: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ data: { ok: true } }) }, finish_reason: "stop" }] }), { status: 200 });
      }) as typeof fetch
    });
    const response = await provider.generateWithTools({
      messages: [{ role: "user", content: "parse" }],
      schema: { type: "object" },
      tools: [],
      temperature: 0
    });
    expect((response.output as { data: { ok: boolean } }).data.ok).toBe(true);
    expect(requestBody?.model).toBe("Qwen-local");
    expect(requestBody?.temperature).toBe(0);
  });

  it("normalizes OpenAI-compatible tool calls", async () => {
    const provider = new QwenProvider({
      endpoint: "http://local.test/chat",
      model: "Qwen-local",
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "1", function: { name: "resolveProductTerm", arguments: JSON.stringify({ term: "Pro" }) } }] } }] }), { status: 200 })) as typeof fetch
    });
    const response = await provider.generateWithTools({ messages: [], schema: {}, tools: [], temperature: 0 });
    expect(response.toolCalls?.[0]?.name).toBe("resolveProductTerm");
    expect(response.toolCalls?.[0]?.arguments).toEqual({ term: "Pro" });
  });
});
