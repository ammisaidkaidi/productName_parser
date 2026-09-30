import type { LLMMessage, LLMToolDefinition } from "../llm/provider.js";
import type { ParserConfig, FieldConfig } from "../schema/config.js";
import { createProductSchema } from "../schema/product.js";
import { seriesEntries } from "../schema/config.js";

export interface PromptInput {
  input: string;
  normalizedInput: string;
  config: ParserConfig;
  tools: LLMToolDefinition[];
}

export interface BuiltPrompt {
  messages: LLMMessage[];
  outputSchema: Record<string, unknown>;
}

export class PromptBuilder {
  build(input: PromptInput): BuiltPrompt {
    const { config } = input;
    const outputSchema = productOutputSchema(config);
    const system = [
      "SYSTEM",
      "You are a deterministic product information extraction engine.",
      "Extract only information supported by the product description or the configured catalog.",
      "Never invent a brand, reference, material, dimension, model, series, category, or color.",
      "Use null for unknown scalar fields and [] for unknown array fields.",
      "Keep dimensions separate from references and models. Preserve the original dimension value and unit.",
      "Prefer explicit evidence over normalized evidence, and configured catalog knowledge over generic assumptions.",
      "If more than one interpretation is plausible, set ambiguous=true, lower confidence, and request a tool instead of guessing.",
      "Do not include chain-of-thought. Return only the requested structured object."
    ].join("\n");

    const fieldRules = Object.entries(config.fields).map(([name, field]) => formatField(name, field)).join("\n\n");
    const brands = config.brands.map((brand) => {
      const series = seriesEntries(brand).map((item) => `${item.name}${item.aliases?.length ? ` (${item.aliases.join(", ")})` : ""}`).join(", ");
      return `- ${brand.name}${brand.aliases?.length ? ` [aliases: ${brand.aliases.join(", ")}]` : ""}${series ? ` → series: ${series}` : ""}`;
    }).join("\n") || "- none configured";
    const categories = [
      ...config.categories.map((item) => `- category: ${item.name}${item.aliases?.length ? ` [${item.aliases.join(", ")}]` : ""}`),
      ...config.subcategories.map((item) => `- subcategory: ${item.name}${item.category ? ` → category: ${item.category}` : ""}${item.aliases?.length ? ` [${item.aliases.join(", ")}]` : ""}`)
    ].join("\n") || "- none configured";
    const tools = input.tools.map((tool) => `- ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`).join("\n") || "- none registered";

    const user = [
      "OBJECTIVE",
      "Parse one product description using the exact output schema below.",
      "\nSCHEMA",
      JSON.stringify(outputSchema, null, 2),
      "\nFIELD RULES",
      fieldRules,
      "\nKNOWN BRANDS AND SERIES",
      brands,
      "\nKNOWN CATEGORIES",
      categories,
      "\nNORMALIZATION RULES",
      JSON.stringify(config.normalization, null, 2),
      "\nAVAILABLE TOOLS",
      tools,
      "\nPRODUCT",
      `rawInput: ${input.input}`,
      `normalizedInput: ${input.normalizedInput}`,
      "\nReturn an object with data and fields. fields contains one confidence/source/ambiguous decision per field."
    ].join("\n");

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      outputSchema
    };
  }
}

export function productOutputSchema(config: ParserConfig): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(config.fields)) {
    properties[name] = field.kind === "stringArray"
      ? { type: "array", items: { type: "string" } }
      : field.kind === "number"
        ? { type: ["number", "null"] }
        : field.kind === "boolean"
          ? { type: ["boolean", "null"] }
          : field.kind === "object"
            ? { type: ["object", "null"] }
            : { type: ["string", "null"] };
  }
  const fieldDecisionProperties: Record<string, unknown> = {};
  for (const name of Object.keys(config.fields)) {
    fieldDecisionProperties[name] = {
      type: "object",
      properties: {
        value: properties[name],
        confidence: { type: "number", minimum: 0, maximum: 1 },
        source: { type: "string", enum: ["explicit", "normalized", "catalog", "inferred", "tool"] },
        ambiguous: { type: "boolean" }
      },
      required: ["value", "confidence", "source", "ambiguous"],
      additionalProperties: false
    };
  }
  return {
    type: "object",
    properties: {
      data: { type: "object", properties, required: Object.keys(properties), additionalProperties: true },
      fields: { type: "object", properties: fieldDecisionProperties, required: Object.keys(fieldDecisionProperties), additionalProperties: false },
      unresolved: { type: "array", items: { type: "string" } }
    },
    required: ["data", "fields"],
    additionalProperties: false
  };
}

function formatField(name: string, field: FieldConfig): string {
  return [
    `${name} (${field.kind ?? "string"})`,
    field.description ? `description: ${field.description}` : "",
    field.instructions?.length ? `instructions:\n${field.instructions.map((item) => `- ${item}`).join("\n")}` : "",
    field.examples?.length ? `examples: ${field.examples.join(", ")}` : "",
    field.allowedValues?.length ? `allowed values: ${field.allowedValues.join(", ")}` : "",
    field.inference ? `inference enabled: ${field.inference.enabled}${field.inference.instructions?.length ? ` (${field.inference.instructions.join("; ")})` : ""}` : ""
  ].filter(Boolean).join("\n");
}
