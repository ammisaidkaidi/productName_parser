import { emptyProduct, type FieldDecisions, type FieldResult, type ProductRecord } from "../schema/product.js";
import type { ParserConfig, FieldConfig, BrandConfig } from "../schema/config.js";
import { aliasesFor, seriesEntries } from "../schema/config.js";
import { key } from "../tools/resolver.js";
import type { Normalizer } from "../normalization/normalizer.js";
import { clamp, sanitizeFieldResult } from "./confidence.js";
import { z } from "zod";
import { parseJsonContent } from "../llm/provider.js";

export interface ExtractionEnvelope {
  data: ProductRecord;
  fields: FieldDecisions;
  unresolved?: string[];
  ambiguityTerms?: Record<string, string>;
}

export function heuristicExtract(input: string, normalizedInput: string, config: ParserConfig): ExtractionEnvelope {
  const data = emptyProduct(config.fields);
  const fields: FieldDecisions = {};
  const ambiguityTerms: Record<string, string> = {};
  for (const name of Object.keys(config.fields)) fields[name] = unknownDecision(config.fields[name]?.kind === "stringArray");

  const usedPhrases: string[] = [];
  const text = normalizedInput;

  const collisage = extractCollisagePrefix(text);
  if (collisage && hasField(config, "collisage")) {
    setField(data, fields, "collisage", collisage.value, 0.99, "explicit");
    usedPhrases.push(collisage.full);
  }

  const abbreviation = extractAbbreviation(text, config);
  if (abbreviation && hasField(config, "abbreviation")) {
    setField(data, fields, "abbreviation", abbreviation.value, abbreviation.confidence, abbreviation.source);
    usedPhrases.push(abbreviation.full);
  }

  const brandMatches = config.brands.filter((brand) => findPhrase(text, aliasesFor(brand.name, brand.aliases)) !== undefined);
  if (brandMatches.length === 1) {
    const brand = brandMatches[0];
    if (brand) {
      setField(data, fields, "brand", brand.name, 0.99, "explicit");
      usedPhrases.push(...aliasesFor(brand.name, brand.aliases));
    }
  } else if (brandMatches.length > 1) {
    const term = brandMatches[0] ? matchingAlias(text, aliasesFor(brandMatches[0].name, brandMatches[0].aliases)) ?? brandMatches[0].name : "brand";
    markAmbiguous(data, fields, "brand", term, ambiguityTerms, ["brand"]);
  }

  const brand = brandMatches.length === 1 ? brandMatches[0] : undefined;
  const seriesMatches = findSeriesMatches(text, config, brand);
  const onlySeries = seriesMatches[0];
  if (brand && seriesMatches.length === 1 && onlySeries) {
    setField(data, fields, "serie", onlySeries.serie.name, 0.98, "catalog");
    usedPhrases.push(...aliasesFor(onlySeries.serie.name, onlySeries.serie.aliases));
  } else if (seriesMatches.length > 0 && onlySeries) {
    const term = matchingAlias(text, aliasesFor(onlySeries.serie.name, onlySeries.serie.aliases)) ?? onlySeries.serie.name;
    markAmbiguous(data, fields, "serie", term, ambiguityTerms, ["serie", "quality", "model"]);
  }

  const categoryMatch = findConfiguredPhrase(text, config.categories);
  if (categoryMatch) {
    setField(data, fields, "category", categoryMatch.value, 0.98, "catalog");
    usedPhrases.push(categoryMatch.matched);
  }
  const subcategoryMatch = findConfiguredPhrase(text, config.subcategories);
  if (subcategoryMatch) {
    setField(data, fields, "subcategory", subcategoryMatch.value, 0.98, "catalog");
    usedPhrases.push(subcategoryMatch.matched);
    const configuredCategory = config.subcategories.find((item) => item.name === subcategoryMatch.value)?.category;
    if (!data.category && configuredCategory) setField(data, fields, "category", configuredCategory, 0.93, "catalog");
  }

  for (const fieldName of Object.keys(config.fields)) {
    if (["category", "subcategory", "abbreviation", "collisage", "brand", "serie", "dims", "ref", "other"].includes(fieldName)) continue;
    const configuredMatch = extractConfiguredField(text, config.fields[fieldName]);
    if (configuredMatch) {
      setField(data, fields, fieldName, configuredMatch.value, configuredMatch.confidence, configuredMatch.source);
      usedPhrases.push(configuredMatch.full);
      continue;
    }
    const match = findFieldMatch(text, config.fields[fieldName]);
    if (!match) continue;
    // A configured brand-series relationship takes precedence over a same-spelled
    // generic quality token when the brand context is explicit.
    if (fieldName === "quality" && typeof data.serie === "string" && key(data.serie) === key(match.value)) continue;
    setField(data, fields, fieldName, match.value, match.confidence, match.source);
    usedPhrases.push(match.matched);
  }

  const refMatch = extractReference(text, config);
  if (refMatch) {
    setField(data, fields, "ref", refMatch.value, 0.995, "explicit");
    usedPhrases.push(refMatch.full);
  }

  const dimensionText = collisage ? text.slice(collisage.full.length).trim() : text;
  const dims = extractDimensions(dimensionText);
  if (dims.length > 0) {
    setField(data, fields, "dims", dims, 0.97, "explicit");
    usedPhrases.push(...dims);
  }

  const standaloneNumber = findStandaloneNumber(dimensionText);
  if (standaloneNumber && dims.length === 0 && !refMatch) {
    if (hasDimensionContext(text, data, config)) {
      // A configured dimensional context such as Tube, Coude, DN, or Diamètre
      // is sufficient evidence to classify a standalone numeric size.
      const dimension = standaloneNumber.replace(/,/g, ".");
      setField(data, fields, "dims", [dimension], 0.94, "explicit");
      usedPhrases.push(standaloneNumber);
    } else {
      // Without context, keep the ambiguity: 110 could be a model or reference.
      markAmbiguous(data, fields, "dims", standaloneNumber, ambiguityTerms, ["dims", "model", "ref", "serie"]);
      if (hasField(config, "model")) markAmbiguous(data, fields, "model", standaloneNumber, ambiguityTerms, ["dims", "model", "ref", "serie"]);
      if (hasField(config, "ref")) markAmbiguous(data, fields, "ref", standaloneNumber, ambiguityTerms, ["dims", "model", "ref", "serie"]);
    }
  }
  const alphanumericCode = findUnmarkedCode(text);
  const configuredModel = data.model !== null && data.model !== undefined;
  if (alphanumericCode && !refMatch && !configuredModel) {
    if (hasField(config, "ref")) markAmbiguous(data, fields, "ref", alphanumericCode, ambiguityTerms, ["ref", "model"]);
    if (hasField(config, "model")) markAmbiguous(data, fields, "model", alphanumericCode, ambiguityTerms, ["ref", "model"]);
  }

  if (hasField(config, "other")) {
    const other = extractOther(text, config, usedPhrases, data, ambiguityTerms);
    setField(data, fields, "other", other, other.length ? 0.88 : 1, "explicit");
  }

  return { data, fields, ambiguityTerms };
}

export function parseExtractionEnvelope(raw: unknown, config: ParserConfig, normalizer: Normalizer): ExtractionEnvelope {
  const parsed = parseJsonContent(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("LLM output was not a JSON object");
  const object = parsed as Record<string, unknown>;
  const rawData = object.data && typeof object.data === "object" ? object.data as Record<string, unknown> : object;
  const schema = dynamicDataSchema(config);
  const dataResult = schema.safeParse(rawData);
  if (!dataResult.success) throw new Error(`LLM schema validation failed: ${dataResult.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`);
  const normalizedData = normalizer.normalizeProduct(dataResult.data);
  const rawFields = object.fields && typeof object.fields === "object" ? object.fields as Record<string, unknown> : {};
  const fields: FieldDecisions = {};
  for (const [name, definition] of Object.entries(config.fields)) {
    if (name in rawFields) fields[name] = sanitizeFieldResult(rawFields[name], name, definition, config);
    else {
      const value = normalizedData[name];
      fields[name] = {
        value: value ?? null,
        confidence: value === null || value === undefined ? 1 : 0.8,
        source: value === null || value === undefined ? "inferred" : "explicit",
        ambiguous: false
      };
    }
  }
  const unresolved = Array.isArray(object.unresolved) ? object.unresolved.filter((item): item is string => typeof item === "string") : [];
  return { data: normalizedData, fields, unresolved };
}

export function mergeDecisionsIntoData(envelope: ExtractionEnvelope, config: ParserConfig, normalizer: Normalizer): ProductRecord {
  const result = emptyProduct(config.fields);
  for (const [name, definition] of Object.entries(config.fields)) {
    const decision = envelope.fields[name];
    const empty = definition.kind === "stringArray" || name === "dims" || name === "other" ? [] : null;
    if (!decision || decision.ambiguous || decision.value === null || decision.value === undefined) result[name] = empty;
    else result[name] = decision.value;
  }
  for (const [name, value] of Object.entries(envelope.data)) {
    if (!(name in result)) result[name] = value;
  }
  return normalizer.normalizeProduct(result);
}

export function validateBusinessRules(data: ProductRecord, config: ParserConfig): string[] {
  const errors: string[] = [];
  for (const [name, field] of Object.entries(config.fields)) {
    const value = data[name];
    const validation = field.validation;
    if (!validation) continue;
    const isEmpty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    if (validation.required && isEmpty) errors.push(`${name} is required`);
    if (typeof value === "string") {
      if (validation.minLength !== undefined && value.length < validation.minLength) errors.push(`${name} is shorter than minLength`);
      if (validation.maxLength !== undefined && value.length > validation.maxLength) errors.push(`${name} is longer than maxLength`);
      if (validation.pattern) {
        try {
          if (!new RegExp(validation.pattern).test(value)) errors.push(`${name} does not match its configured pattern`);
        } catch {
          errors.push(`${name} has an invalid validation pattern`);
        }
      }
    }
  }
  return errors;
}

function dynamicDataSchema(config: ParserConfig): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, field] of Object.entries(config.fields)) {
    shape[name] = field.kind === "stringArray" || name === "dims" || name === "other"
      ? z.array(z.string())
      : field.kind === "number" ? z.number().nullable()
        : field.kind === "boolean" ? z.boolean().nullable()
          : field.kind === "object" ? z.record(z.unknown()).nullable()
            : z.string().nullable();
  }
  return z.object(shape).passthrough() as z.ZodType<Record<string, unknown>>;
}

function unknownDecision(array: boolean): FieldResult<unknown> {
  return { value: array ? [] : null, confidence: 1, source: "inferred", ambiguous: false };
}

function setField(data: ProductRecord, fields: FieldDecisions, name: string, value: unknown, confidence: number, source: FieldResult<unknown>["source"]): void {
  if (!(name in data)) return;
  data[name] = value;
  fields[name] = { value, confidence: clamp(confidence), source, ambiguous: false };
}

function markAmbiguous(data: ProductRecord, fields: FieldDecisions, name: string, term: string, terms: Record<string, string>, candidates: string[]): void {
  if (!(name in data)) return;
  const empty = Array.isArray(data[name]) ? [] : null;
  data[name] = empty;
  fields[name] = { value: null, confidence: 0.45, source: "inferred", ambiguous: true };
  terms[name] = term;
  // Candidate fields are retained in a private, deterministic hint field for the parser.
  terms[`${name}.__candidates`] = candidates.join(",");
}

function findSeriesMatches(text: string, config: ParserConfig, brand?: BrandConfig): Array<{ brand: BrandConfig; serie: ReturnType<typeof seriesEntries>[number] }> {
  const brands = brand ? [brand] : config.brands;
  const matches: Array<{ brand: BrandConfig; serie: ReturnType<typeof seriesEntries>[number] }> = [];
  for (const item of brands) {
    for (const serie of seriesEntries(item)) {
      if (findPhrase(text, aliasesFor(serie.name, serie.aliases)) !== undefined) matches.push({ brand: item, serie });
    }
  }
  return matches;
}

function findConfiguredPhrase<T extends { name: string; aliases?: string[] }>(text: string, values: T[]): { value: string; matched: string } | undefined {
  const matches = values.flatMap((value) => {
    const matched = matchingAlias(text, aliasesFor(value.name, value.aliases));
    return matched ? [{ value: value.name, matched }] : [];
  });
  return matches.sort((a, b) => b.matched.length - a.matched.length)[0];
}

function findFieldMatch(text: string, field: FieldConfig | undefined): { value: string; matched: string; confidence: number; source: FieldResult<unknown>["source"] } | undefined {
  if (!field) return undefined;
  const values = field.allowedValues ?? [];
  const candidates = [
    ...values.map((value) => ({ value, aliases: Object.entries(field.aliases ?? {}).filter(([, canonical]) => canonical === value).map(([alias]) => alias) })),
    ...Object.entries(field.aliases ?? {}).filter(([, canonical]) => !values.includes(canonical)).map(([alias, value]) => ({ value, aliases: [alias] }))
  ];
  const matches = candidates.flatMap((candidate) => {
    const matched = matchingAlias(text, aliasesFor(candidate.value, candidate.aliases));
    return matched ? [{ value: candidate.value, matched, confidence: key(candidate.value) === key(matched) ? 0.98 : 0.91, source: key(candidate.value) === key(matched) ? "explicit" as const : "normalized" as const }] : [];
  });
  return matches.sort((a, b) => b.matched.length - a.matched.length)[0];
}

function extractConfiguredField(text: string, field: FieldConfig | undefined): { value: string; full: string; confidence: number; source: FieldResult<unknown>["source"] } | undefined {
  const patterns = field?.extract?.patterns ?? [];
  const flags = field?.extract?.flags ?? "i";
  const capture = field?.extract?.captureGroup ?? 1;
  for (const pattern of patterns) {
    try {
      const match = new RegExp(pattern, flags).exec(text);
      if (!match) continue;
      const value = match[capture] ?? match[0];
      if (value) return { value, full: match[0], confidence: 0.98, source: "explicit" };
    } catch {
      // Invalid administrator patterns are ignored by extraction and remain visible through config validation.
    }
  }
  return undefined;
}

function extractReference(text: string, config: ParserConfig): { value: string; full: string } | undefined {
  const field = config.fields.ref;
  const patterns = field?.extract?.patterns ?? ["\\b(?:REF|RÉF|REFERENCE)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9/_-]*)"];
  const flags = field?.extract?.flags ?? "i";
  const capture = field?.extract?.captureGroup ?? 1;
  for (const pattern of patterns) {
    try {
      const match = new RegExp(pattern, flags).exec(text);
      if (match?.[capture]) return { value: match[capture], full: match[0] };
    } catch {
      // A malformed administrator pattern is reported by business validation in the public pipeline.
    }
  }
  return undefined;
}

function extractDimensions(text: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const normalized = value.replace(/\s+/g, "").replace(/,/g, ".");
    if (!found.includes(normalized)) found.push(normalized);
  };
  for (const match of text.match(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?(?:\s*x\s*\d+(?:[.,]\d+)?)?\b/gi) ?? []) add(match);
  for (const match of text.match(/\b\d+\s*\/\s*\d+\b/g) ?? []) add(match);
  for (const match of text.match(/\bM\s*\d+(?:[.,]\d+)?\b/gi) ?? []) add(match);
  for (const match of text.match(/\b\d+(?:[.,]\d+)?\s*(?:mm|cm|m|in|deg|degr(?:é|e)s?)\b/gi) ?? []) add(match);
  for (const match of text.match(/\b\d+(?:[.,]\d+)?\s*°/g) ?? []) add(match.replace(/\s+/g, ""));
  return found;
}

function findStandaloneNumber(text: string): string | undefined {
  const masked = text.replace(/\b\d+\s*\/\s*\d+\b/g, " ").replace(/\b\d+(?:[.,]\d+)?\s*x\s*\d+(?:[.,]\d+)?\b/gi, " ");
  return masked.match(/\b\d+(?:[.,]\d+)?\b/)?.[0];
}

function findUnmarkedCode(text: string): string | undefined {
  return text.match(/\b[A-Z]{2,}[A-Z0-9_-]*\d[A-Z0-9_-]*\b/i)?.[0];
}

function extractOther(text: string, config: ParserConfig, usedPhrases: string[], data: ProductRecord, ambiguityTerms: Record<string, string>): string[] {
  const consumed = new Set<string>();
  for (const phrase of usedPhrases) for (const token of phrase.split(/\s+/)) consumed.add(key(token));
  for (const value of Object.values(data)) {
    if (typeof value === "string") for (const token of value.split(/\s+/)) consumed.add(key(token));
    if (Array.isArray(value)) for (const item of value) if (typeof item === "string") for (const token of item.split(/\s+/)) consumed.add(key(token));
  }
  for (const term of Object.values(ambiguityTerms)) consumed.add(key(term));
  const markers = new Set(["ref", "réf", "reference", "arret", "arrêt", "robinet", "tube", "longueur"]);
  const knownCatalog = new Set<string>();
  for (const brand of config.brands) for (const token of aliasesFor(brand.name, brand.aliases).join(" ").split(/\s+/)) knownCatalog.add(key(token));
  const output: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) {
      const phrase = pending.join(" ");
      if (!output.includes(phrase)) output.push(phrase);
      pending = [];
    }
  };
  for (const token of text.split(/\s+/)) {
    const normalized = token.replace(/[,:]/g, "");
    const tokenKey = key(normalized);
    const consumedToken = !tokenKey || consumed.has(tokenKey) || markers.has(tokenKey) || knownCatalog.has(tokenKey);
    const numericToken = /^\d/.test(tokenKey) || /^m\d/i.test(tokenKey);
    const meaningfulToken = /^[A-Z]{2,}[A-Z0-9_-]*$/.test(normalized) || !config.fields.material?.allowedValues?.some((value) => key(value) === tokenKey);
    if (consumedToken || numericToken || !meaningfulToken) {
      flush();
      continue;
    }
    pending.push(normalized);
  }
  flush();
  return output;
}

interface PrefixMatch {
  value: string;
  full: string;
}

interface AbbreviationMatch extends PrefixMatch {
  confidence: number;
  source: FieldResult<unknown>["source"];
}

function extractCollisagePrefix(text: string): PrefixMatch | undefined {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens[0]) return undefined;
  const candidates = [tokens[0], tokens.length > 1 ? `${tokens[0]} ${tokens[1]}` : undefined].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const compact = candidate.replace(/[,:;]+$/g, "").replace(/\s+/g, "");
    if (!isPackagingTerm(compact)) continue;
    return { value: compact.toLocaleLowerCase(), full: candidate.replace(/[,:;]+$/g, "") };
  }
  return undefined;
}

function isPackagingTerm(value: string): boolean {
  return /^(?:\d+(?:[.,]\d+)?(?:pcs?|pc|pce|pieces?|pièces?|kg|kgrs?|g|dz|m|cm|mm|l|ml|rlx|rouleaux?|jeux?|lots?|box|carton|paquet)|pcs?|pces?|pieces?|pièces?|jeux?|jeu|rlx|lot|lots|box|carton|paquet)$/iu.test(value) && !/^pc$/iu.test(value);
}

function extractAbbreviation(text: string, config: ParserConfig): AbbreviationMatch | undefined {
  const first = text.trim().split(/\s+/).find(Boolean)?.replace(/^[,;:]+|[,;:]+$/g, "");
  if (!first || isPackagingTerm(first)) return undefined;
  const configuredName = findFieldMatch(text, config.fields.name);
  if (configuredName && key(configuredName.matched.split(/\s+/)[0] ?? "") === key(first)) return undefined;
  const field = config.fields.abbreviation;
  const candidates = [
    ...(field?.allowedValues ?? []).map((value) => ({ value, aliases: Object.entries(field?.aliases ?? {}).filter(([, canonical]) => canonical === value).map(([alias]) => alias) })),
    ...Object.entries(field?.aliases ?? {}).filter(([, canonical]) => !(field?.allowedValues ?? []).includes(canonical)).map(([alias, value]) => ({ value, aliases: [alias] }))
  ];
  for (const candidate of candidates) {
    if (aliasesFor(candidate.value, candidate.aliases).some((alias) => key(alias) === key(first))) {
      return { value: candidate.value, full: first, confidence: 0.99, source: key(candidate.value) === key(first) ? "explicit" : "normalized" };
    }
  }
  // Conservative generic rule: a short all-capital alphabetic prefix is an
  // abbreviation; normal words such as ROBINET and COUDE are not classified as one.
  if (/^[A-Z]{2,4}$/.test(first)) return { value: first, full: first, confidence: 0.94, source: "explicit" };
  return undefined;
}

function hasField(config: ParserConfig, name: string): boolean {
  return name in config.fields;
}

function hasDimensionContext(text: string, data: ProductRecord, config: ParserConfig): boolean {
  const configuredTerms = config.fields.dims?.extract?.contextTerms ?? [];
  const terms = configuredTerms.length > 0
    ? configuredTerms
    : ["tube", "tuyau", "coude", "dn", "diam", "diamètre", "diameter", "dimension", "longueur", "largeur", "hauteur", "ø"];
  if (terms.some((term) => findPhrase(text, [term]) !== undefined)) return true;
  const subcategory = typeof data.subcategory === "string" ? key(data.subcategory) : "";
  return ["tube", "tuyau", "coude", "raccord"].includes(subcategory);
}

function findPhrase(text: string, aliases: string[]): number | undefined {
  for (const alias of aliases) {
    const index = text.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase());
    if (index >= 0) {
      const before = text[index - 1];
      const after = text[index + alias.length];
      if ((!before || /[^\p{L}\p{N}]/u.test(before)) && (!after || /[^\p{L}\p{N}]/u.test(after))) return index;
    }
  }
  return undefined;
}

function matchingAlias(text: string, aliases: string[]): string | undefined {
  let best: string | undefined;
  for (const alias of aliases) if (findPhrase(text, [alias]) !== undefined && (!best || alias.length > best.length)) best = alias;
  return best;
}
