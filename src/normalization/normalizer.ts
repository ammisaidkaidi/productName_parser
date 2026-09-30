import { emptyProduct, type ProductRecord } from "../schema/product.js";
import type { ParserConfig } from "../schema/config.js";
import { normalizeArray, normalizeScalar, preNormalize } from "./rules.js";

export class Normalizer {
  constructor(private readonly config: ParserConfig) {}

  preNormalize(input: string): string {
    return preNormalize(input, this.config);
  }

  normalizeProduct(value: unknown): ProductRecord {
    const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const result = emptyProduct(this.config.fields);
    for (const [fieldName, definition] of Object.entries(this.config.fields)) {
      const current = source[fieldName];
      if (definition.kind === "stringArray" || fieldName === "dims" || fieldName === "other") {
        result[fieldName] = normalizeArray(current, definition, fieldName, this.config);
      } else {
        result[fieldName] = current === null || current === undefined || current === ""
          ? null
          : normalizeScalar(current, definition, fieldName, this.config);
      }
    }

    // Tolerate an LLM returning a custom field that was not present at prompt time,
    // while keeping the parser extensible and never dropping explicit values.
    for (const [fieldName, current] of Object.entries(source)) {
      if (!(fieldName in result)) result[fieldName] = current;
    }
    return result;
  }
}

export * from "./rules.js";
