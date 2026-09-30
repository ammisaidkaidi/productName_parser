import { z } from "zod";

export type FieldKind = "string" | "stringArray" | "number" | "boolean" | "object";

export interface SeriesConfig {
  name: string;
  aliases?: string[];
}

export interface BrandConfig {
  name: string;
  aliases?: string[];
  series?: Array<string | SeriesConfig>;
}

export interface CategoryConfig {
  name: string;
  aliases?: string[];
}

export interface SubcategoryConfig {
  name: string;
  aliases?: string[];
  category?: string;
}

export type NormalizationRule =
  | { type: "map"; values: Record<string, string> }
  | { type: "replace"; from: string; to: string; flags?: string }
  | { type: "regex"; pattern: string; replacement: string; flags?: string }
  | { type: "trim" }
  | { type: "lowercase" }
  | { type: "uppercase" };

export interface ExtractRule {
  patterns?: string[];
  flags?: string;
  captureGroup?: number;
  /** Context terms that make an otherwise ambiguous token safe to extract for this field. */
  contextTerms?: string[];
}

export interface FieldConfig {
  kind?: FieldKind;
  description?: string;
  instructions?: string[];
  examples?: string[];
  allowedValues?: string[];
  aliases?: Record<string, string>;
  normalization?: NormalizationRule[];
  validation?: {
    required?: boolean;
    pattern?: string;
    minLength?: number;
    maxLength?: number;
  };
  extract?: ExtractRule;
  confidence?: Partial<ConfidenceThresholds>;
  inference?: {
    enabled: boolean;
    instructions?: string[];
  };
  defaultValue?: unknown;
}

export interface ConfidenceThresholds {
  autoAccept: number;
  requireTool: number;
  rejectBelow: number;
}

export interface AmbiguityPolicy {
  onAmbiguity: "tool" | "null" | "acceptHighest";
  maxCandidates: number;
}

export interface RetryConfig {
  maxRetries: number;
  maxToolCalls: number;
  timeoutMs: number;
}

export interface NormalizationConfig {
  rules?: NormalizationRule[];
  preserveCaseFields?: string[];
  unicodeNormalize?: "NFC" | "NFKC" | false;
}

export interface ParserConfig {
  brands: BrandConfig[];
  categories: CategoryConfig[];
  subcategories: SubcategoryConfig[];
  fields: Record<string, FieldConfig>;
  normalization: NormalizationConfig;
  confidence: ConfidenceThresholds;
  ambiguity: AmbiguityPolicy;
  retry: RetryConfig;
  concurrency: number;
  modelName?: string;
}

export const ConfidenceSchema = z.object({
  autoAccept: z.number().min(0).max(1),
  requireTool: z.number().min(0).max(1),
  rejectBelow: z.number().min(0).max(1)
});

const NormalizationRuleSchema = z.union([
  z.object({ type: z.literal("map"), values: z.record(z.string()) }),
  z.object({ type: z.literal("replace"), from: z.string(), to: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal("regex"), pattern: z.string(), replacement: z.string(), flags: z.string().optional() }),
  z.object({ type: z.literal("trim") }),
  z.object({ type: z.literal("lowercase") }),
  z.object({ type: z.literal("uppercase") })
]);

export const ParserConfigSchema = z.object({
  brands: z.array(z.object({
    name: z.string().min(1),
    aliases: z.array(z.string()).optional(),
    series: z.array(z.union([z.string(), z.object({ name: z.string(), aliases: z.array(z.string()).optional() })])).optional()
  })),
  categories: z.array(z.object({ name: z.string(), aliases: z.array(z.string()).optional() })),
  subcategories: z.array(z.object({ name: z.string(), aliases: z.array(z.string()).optional(), category: z.string().optional() })),
  fields: z.record(z.object({
    kind: z.enum(["string", "stringArray", "number", "boolean", "object"]).optional(),
    description: z.string().optional(),
    instructions: z.array(z.string()).optional(),
    examples: z.array(z.string()).optional(),
    allowedValues: z.array(z.string()).optional(),
    aliases: z.record(z.string()).optional(),
    normalization: z.array(NormalizationRuleSchema).optional(),
    validation: z.object({ required: z.boolean().optional(), pattern: z.string().optional(), minLength: z.number().optional(), maxLength: z.number().optional() }).optional(),
    extract: z.object({ patterns: z.array(z.string()).optional(), flags: z.string().optional(), captureGroup: z.number().int().optional(), contextTerms: z.array(z.string()).optional() }).optional(),
    confidence: ConfidenceSchema.partial().optional(),
    inference: z.object({ enabled: z.boolean(), instructions: z.array(z.string()).optional() }).optional(),
    defaultValue: z.unknown().optional()
  })),
  normalization: z.object({ rules: z.array(NormalizationRuleSchema).optional(), preserveCaseFields: z.array(z.string()).optional(), unicodeNormalize: z.union([z.literal("NFC"), z.literal("NFKC"), z.literal(false)]).optional() }),
  confidence: ConfidenceSchema,
  ambiguity: z.object({ onAmbiguity: z.enum(["tool", "null", "acceptHighest"]), maxCandidates: z.number().int().positive() }),
  retry: z.object({ maxRetries: z.number().int().nonnegative(), maxToolCalls: z.number().int().nonnegative(), timeoutMs: z.number().positive() }),
  concurrency: z.number().int().positive(),
  modelName: z.string().optional()
});

export const DEFAULT_FIELD_CONFIG: Record<string, FieldConfig> = {
  category: { kind: "string", description: "Broad product category." },
  subcategory: { kind: "string", description: "Product subcategory." },
  name: { kind: "string", description: "Canonical product name." },
  abbreviation: {
    kind: "string",
    description: "Short product abbreviation taken from the first description term when the configured abbreviation rule authorizes it.",
    instructions: ["Prefer the first term only.", "Do not treat a normal long product name as an abbreviation unless configured."]
  },
  collisage: {
    kind: "string",
    description: "Packaging or selling-unit prefix at the start of the description, such as 1pcs, 1kg, 1kgrs, jeux, 1dz, 1m, or rlx.",
    normalization: [{ type: "lowercase" }],
    instructions: ["Recognize only a packaging/selling-unit prefix at the beginning of the description."]
  },
  model: { kind: "string", description: "Product model or model family. Never use a reference unless supported." },

  brand: { kind: "string", description: "Manufacturer or brand." },
  serie: { kind: "string", description: "Brand-specific series or range." },
  quality: { kind: "string", description: "Quality, grade, or finish designation." },
  material: { kind: "string", description: "Explicit material only; do not infer without configuration." },
  dims: { kind: "stringArray", description: "Physical dimensions, connection sizes, diameters, lengths, and widths." },
  color: { kind: "string", description: "Explicit color." },
  ref: { kind: "string", description: "Product or manufacturer reference." },
  other: { kind: "stringArray", description: "Meaningful unsupported tokens that should be preserved." }
};

export const DEFAULT_CONFIG: ParserConfig = {
  brands: [],
  categories: [],
  subcategories: [],
  fields: { ...DEFAULT_FIELD_CONFIG },
  normalization: { unicodeNormalize: "NFKC", rules: [] },
  confidence: { autoAccept: 0.9, requireTool: 0.75, rejectBelow: 0.5 },
  ambiguity: { onAmbiguity: "tool", maxCandidates: 8 },
  retry: { maxRetries: 2, maxToolCalls: 3, timeoutMs: 10_000 },
  concurrency: 4
};

export function mergeParserConfig(input: Partial<ParserConfig> = {}): ParserConfig {
  const fields: Record<string, FieldConfig> = { ...DEFAULT_FIELD_CONFIG };
  for (const [name, definition] of Object.entries(input.fields ?? {})) {
    fields[name] = { ...(fields[name] ?? {}), ...definition };
  }

  const merged: ParserConfig = {
    ...DEFAULT_CONFIG,
    ...input,
    brands: input.brands ?? DEFAULT_CONFIG.brands,
    categories: input.categories ?? DEFAULT_CONFIG.categories,
    subcategories: input.subcategories ?? DEFAULT_CONFIG.subcategories,
    fields,
    normalization: { ...DEFAULT_CONFIG.normalization, ...(input.normalization ?? {}) },
    confidence: { ...DEFAULT_CONFIG.confidence, ...(input.confidence ?? {}) },
    ambiguity: { ...DEFAULT_CONFIG.ambiguity, ...(input.ambiguity ?? {}) },
    retry: { ...DEFAULT_CONFIG.retry, ...(input.retry ?? {}) },
    concurrency: input.concurrency ?? DEFAULT_CONFIG.concurrency
  };
  return ParserConfigSchema.parse(merged) as ParserConfig;
}

export function seriesEntries(brand: BrandConfig): SeriesConfig[] {
  return (brand.series ?? []).map((series) => typeof series === "string" ? { name: series } : series);
}

export function aliasesFor(canonical: string, aliases: string[] | undefined): string[] {
  return [canonical, ...(aliases ?? [])];
}
