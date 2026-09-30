import type { FieldConfig, NormalizationRule, ParserConfig } from "../schema/config.js";
import { key } from "../tools/resolver.js";

export function applyRules(value: string, rules: NormalizationRule[] = []): string {
  let result = value;
  for (const rule of rules) {
    switch (rule.type) {
      case "trim":
        result = result.trim();
        break;
      case "lowercase":
        result = result.toLocaleLowerCase();
        break;
      case "uppercase":
        result = result.toLocaleUpperCase();
        break;
      case "map": {
        const mapped = Object.entries(rule.values).find(([from]) => key(from) === key(result));
        if (mapped) result = mapped[1];
        break;
      }
      case "replace":
        result = result.replace(new RegExp(escapeRegExp(rule.from), rule.flags ?? "g"), rule.to);
        break;
      case "regex":
        result = result.replace(new RegExp(rule.pattern, rule.flags ?? "g"), rule.replacement);
        break;
    }
  }
  return result;
}

export function normalizeScalar(value: unknown, field: FieldConfig | undefined, fieldName: string, config: ParserConfig): unknown {
  if (typeof value !== "string") return value;
  let result = value.trim();
  const aliases = field?.aliases ?? {};
  const alias = Object.entries(aliases).find(([from]) => key(from) === key(result));
  if (alias) result = alias[1];
  result = applyRules(result, field?.normalization);
  if (!config.normalization.preserveCaseFields?.includes(fieldName) && fieldName !== "ref" && fieldName !== "model" && fieldName !== "other") {
    const allowed = field?.allowedValues?.find((candidate) => key(candidate) === key(result));
    if (allowed) result = allowed;
  }
  return result;
}

export function preNormalize(input: string, config: ParserConfig): string {
  const form = config.normalization.unicodeNormalize;
  let result = form === false ? input : input.normalize(form ?? "NFKC");
  result = applyRules(result, config.normalization.rules);
  result = result
    .replace(/[\u00a0\t\r\n]+/g, " ")
    .replace(/\s*\/\s*/g, "/")
    // Normalize multiplication signs only when x is between numeric tokens;
    // never remove the space after a word ending in x (for example JEUX).
    .replace(/(\d)\s*[x×]\s*(?=\d)/gi, "$1x")
    .replace(/\s*:\s*/g, ": ")
    .replace(/\s+/g, " ")
    .trim();
  return result;
}

export function normalizeArray(value: unknown, field: FieldConfig | undefined, fieldName: string, config: ParserConfig): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => String(normalizeScalar(item, field, fieldName, config)))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
