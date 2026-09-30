import type { ParserConfig, BrandConfig } from "../schema/config.js";
import { aliasesFor, seriesEntries } from "../schema/config.js";
import type { ParserTool } from "./types.js";

export interface ResolveCandidate {
  field: string;
  value: string;
  brand?: string;
}

export interface ResolveProductTermInput {
  term: string;
  context?: string | null;
  candidateFields?: string[];
}

export interface ResolveProductTermResult {
  status: "resolved" | "ambiguous" | "unresolved";
  field?: string;
  value?: string;
  confidence?: number;
  candidates?: ResolveCandidate[];
}

export function createResolveProductTermTool(config: ParserConfig): ParserTool {
  return {
    name: "resolveProductTerm",
    description: "Resolve an ambiguous product token using the configured brand, series, and field catalog. Return unresolved rather than guessing.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        context: { type: ["string", "null"] },
        candidateFields: { type: "array", items: { type: "string" } }
      },
      required: ["term"]
    },
    async execute(input: unknown): Promise<ResolveProductTermResult> {
      return resolveProductTerm(config, input);
    }
  };
}

export function resolveProductTerm(config: ParserConfig, rawInput: unknown): ResolveProductTermResult {
  if (!rawInput || typeof rawInput !== "object") return { status: "unresolved" };
  const input = rawInput as Partial<ResolveProductTermInput>;
  const term = typeof input.term === "string" ? input.term.trim() : "";
  const context = typeof input.context === "string" ? input.context.trim() : "";
  const requested = new Set(input.candidateFields ?? []);
  if (!term) return { status: "unresolved" };
  const normalizedTerm = key(term);
  const candidates: ResolveCandidate[] = [];

  if (requested.size === 0 || requested.has("brand")) {
    for (const brand of config.brands) {
      if (aliasesFor(brand.name, brand.aliases).some((alias) => key(alias) === normalizedTerm)) {
        candidates.push({ field: "brand", value: brand.name });
      }
    }
  }

  if (requested.size === 0 || requested.has("serie")) {
    const contextBrand = findBrand(config.brands, context);
    const brands = contextBrand ? [contextBrand] : config.brands;
    for (const brand of brands) {
      for (const serie of seriesEntries(brand)) {
        if (aliasesFor(serie.name, serie.aliases).some((alias) => key(alias) === normalizedTerm)) {
          candidates.push({ field: "serie", value: serie.name, brand: brand.name });
        }
      }
    }
  }

  for (const [fieldName, field] of Object.entries(config.fields)) {
    if (fieldName === "brand" || fieldName === "serie" || fieldName === "dims" || fieldName === "ref") continue;
    if (requested.size > 0 && !requested.has(fieldName)) continue;
    const values = field.allowedValues ?? [];
    for (const value of values) {
      const alias = Object.entries(field.aliases ?? {}).find(([aliasName, canonical]) => canonical === value && key(aliasName) === normalizedTerm);
      if (key(value) === normalizedTerm || alias) candidates.push({ field: fieldName, value });
    }
  }

  const unique = dedupe(candidates);
  const only = unique[0];
  if (unique.length === 1 && only && contextMatches(only, context, config)) {
    return { status: "resolved", field: only.field, value: only.value, confidence: 0.98 };
  }
  if (unique.length > 0) {
    return { status: "ambiguous", candidates: unique.slice(0, config.ambiguity.maxCandidates) };
  }
  return { status: "unresolved" };
}

function contextMatches(candidate: ResolveCandidate, context: string, config: ParserConfig): boolean {
  if (candidate.field !== "serie") return true;
  if (!context) return false;
  const brand = config.brands.find((entry) => entry.name === candidate.brand);
  return Boolean(brand && aliasesFor(brand.name, brand.aliases).some((alias) => key(alias) === key(context)));
}

function findBrand(brands: BrandConfig[], value: string): BrandConfig | undefined {
  if (!value) return undefined;
  return brands.find((brand) => aliasesFor(brand.name, brand.aliases).some((alias) => key(alias) === key(value)));
}

function dedupe(candidates: ResolveCandidate[]): ResolveCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const signature = `${candidate.field}|${candidate.value}|${candidate.brand ?? ""}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function key(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}
