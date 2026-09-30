import { describe, expect, it } from "vitest";
import { ProductParser } from "../src/core/parser.js";
import { confidenceAction } from "../src/core/confidence.js";
import type { LLMProvider, LLMToolResponse } from "../src/llm/provider.js";
import { exampleConfig } from "../examples/config.js";

class FakeProvider implements LLMProvider {
  readonly modelName = "fake-qwen";
  constructor(private readonly responses: LLMToolResponse[]) {}
  async generateStructured(): Promise<unknown> { return {}; }
  async generateWithTools(): Promise<LLMToolResponse> {
    const response = this.responses.shift();
    if (!response) throw new Error("fake provider exhausted");
    return response;
  }
}

function envelope(data: Record<string, unknown>): LLMToolResponse {
  return { output: { data } };
}

const emptyData = {
  category: null, subcategory: null, name: null, abbreviation: null, collisage: null, model: null, brand: null, serie: null,
  quality: null, material: null, dims: [], color: null, ref: null, other: []
};

describe("ProductParser pipeline", () => {
  it("produces the requested clear canonical output", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse("ROBINET ARRET LAITON MF 1/2 SOMATHERM PRO REF RA12");
    expect(result.data).toEqual({
      category: "plomberie", subcategory: "robinet", name: "robinet d'arrêt", abbreviation: null, collisage: null, model: null,
      brand: "Somatherm", serie: "Pro", quality: null, material: "laiton", dims: ["1/2"],
      color: null, ref: "RA12", other: ["MF"]
    });
  });

  it("does not hallucinate missing catalog properties", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse("Robinet 1/2");
    expect(result.data.brand).toBeNull();
    expect(result.data.material).toBeNull();
    expect(result.data.ref).toBeNull();
    expect(result.data.dims).toEqual(["1/2"]);
  });

  it("separates dimensions from references and supports multiple dimensions", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse("Tube PVC 110x3.2 longueur 4m");
    expect(result.data.dims).toEqual(["110x3.2", "4m"]);
    expect(result.data.ref).toBeNull();
  });

  it("recognizes a standalone numeric dimension in configured product context", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse("Coude PVC 110");
    expect(result.data.name).toBe("coude");
    expect(result.data.dims).toEqual(["110"]);
    expect(result.data.other).not.toContain("Coude");
    expect(result.metadata.toolsUsed).not.toContain("resolveProductTerm");
  });

  it("extracts a short first-term abbreviation", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse("COU PVC COUDE 110");
    expect(result.data.abbreviation).toBe("COU");
    expect(result.data.name).toBe("coude");
  });

  it("parses PC products without treating pc as collisage", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse("pc portable hp pavillon dv5 core duo");
    expect(result.data.category).toBe("informatique");
    expect(result.data.subcategory).toBe("pc portable");
    expect(result.data.name).toBe("pc portable");
    expect(result.data.collisage).toBeNull();
    expect(result.data.brand).toBe("HP");
    expect(result.data.serie).toBe("Pavilion");
    expect(result.data.model).toBe("DV5");
    expect(result.data.other).toEqual(["core duo"]);
  });

  it.each(["1pcs", "1kg", "1kgrs", "jeux", "1dz", "1m", "rlx"])("extracts collisage prefix %s", async (prefix) => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse(`${prefix} Coude PVC 110`);
    expect(result.data.collisage).toBe(prefix);
    expect(result.data.name).toBe("coude");
  });

  it("detects ambiguity and uses the resolver tool instead of guessing", async () => {
    const parser = new ProductParser({ config: exampleConfig, debug: true });
    const result = await parser.parse("Robinet Pro 1/2");
    expect(result.data.serie).toBeNull();
    expect(result.metadata.toolsUsed).toContain("resolveProductTerm");
    expect(result.metadata.debug?.toolCalls.length).toBeGreaterThan(0);
    expect(result.metadata.warnings.some((item) => item.includes("Unresolved ambiguity"))).toBe(true);
  });

  it("handles malformed LLM output with a bounded retry", async () => {
    const provider = new FakeProvider([
      { output: "not json" },
      envelope({ ...emptyData, subcategory: "robinet", name: "robinet d'arrêt", dims: ["1/2"] })
    ]);
    const parser = new ProductParser({ config: exampleConfig, llm: provider, debug: true });
    const result = await parser.parse("Robinet 1/2");
    expect(result.data.dims).toEqual(["1/2"]);
    expect(result.metadata.debug?.validationErrors.length).toBeGreaterThan(0);
    expect(result.metadata.modelName).toBe("fake-qwen");
  });

  it("executes an LLM-requested registered tool", async () => {
    const provider = new FakeProvider([
      {
        toolCalls: [{ id: "call-1", name: "resolveProductTerm", arguments: { term: "Pro", context: "Somatherm", candidateFields: ["serie"] } }],
        raw: { tool: true }
      },
      envelope({ ...emptyData, brand: "Somatherm", serie: "Pro", dims: ["1/2"] })
    ]);
    const parser = new ProductParser({ config: exampleConfig, llm: provider, debug: true });
    const result = await parser.parse("Somatherm Pro 1/2");
    expect(result.data.serie).toBe("Pro");
    expect(result.metadata.toolsUsed).toContain("resolveProductTerm");
    expect(result.metadata.debug?.toolCalls[0]?.name).toBe("resolveProductTerm");
  });

  it("turns a tool failure into an unresolved field rather than crashing", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    parser.registerTool({
      name: "resolveProductTerm",
      description: "test failure",
      async execute(): Promise<unknown> { throw new Error("lookup offline"); }
    });
    const result = await parser.parse("Robinet Pro 1/2");
    expect(result.data.serie).toBeNull();
    expect(result.metadata.warnings.some((item) => item.includes("lookup offline"))).toBe(true);
  });

  it("supports controlled-concurrency batch parsing", async () => {
    const parser = new ProductParser({ config: exampleConfig });
    const results = await parser.parseBatch(["Robinet 1/2", "Tube PVC 110x3.2", "Robinet ABC110"], { concurrency: 2 });
    expect(results).toHaveLength(3);
    expect(results[1]?.data.dims).toEqual(["110x3.2"]);
  });

  it("supports configuration overrides and custom fields", async () => {
    const config = {
      ...exampleConfig,
      fields: { ...exampleConfig.fields, pressure: { kind: "string" as const, allowedValues: ["PN16"], aliases: { "PN 16": "PN16" } } }
    };
    const parser = new ProductParser({ config });
    const result = await parser.parse("Tube PVC PN 16");
    expect(result.data.pressure).toBe("PN16");
  });

  it("applies configurable confidence actions", () => {
    expect(confidenceAction(0.95, false, exampleConfig.confidence)).toBe("accept");
    expect(confidenceAction(0.8, false, exampleConfig.confidence)).toBe("tool");
    expect(confidenceAction(0.2, false, exampleConfig.confidence)).toBe("reject");
    expect(confidenceAction(0.99, true, exampleConfig.confidence)).toBe("tool");
  });
});
