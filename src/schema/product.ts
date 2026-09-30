import { z } from "zod";
import type { FieldConfig, FieldKind } from "./config.js";

export const BASE_PRODUCT_FIELDS = [
  "category",
  "subcategory",
  "name",
  "abbreviation",
  "collisage",
  "model",
  "brand",
  "serie",
  "quality",
  "material",
  "dims",
  "color",
  "ref",
  "other"
] as const;

export type BaseProductField = (typeof BASE_PRODUCT_FIELDS)[number];

export interface ParsedProduct {
  category: string | null;
  subcategory: string | null;
  name: string | null;
  abbreviation: string | null;
  collisage: string | null;
  model: string | null;
  brand: string | null;
  serie: string | null;
  quality: string | null;
  material: string | null;
  dims: string[];
  color: string | null;
  ref: string | null;
  other: string[];
  [key: string]: unknown;
}

export type ProductRecord = ParsedProduct & Record<string, unknown>;

export type FieldSource = "explicit" | "normalized" | "catalog" | "inferred" | "tool";

export interface FieldResult<T> {
  value: T | null;
  confidence: number;
  source: FieldSource;
  ambiguous: boolean;
}

export type FieldDecisions = Record<string, FieldResult<unknown>>;

export const ParsedProductSchema = z
  .object({
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
    name: z.string().nullable(),
    abbreviation: z.string().nullable(),
    collisage: z.string().nullable(),
    model: z.string().nullable(),
    brand: z.string().nullable(),
    serie: z.string().nullable(),
    quality: z.string().nullable(),
    material: z.string().nullable(),
    dims: z.array(z.string()),
    color: z.string().nullable(),
    ref: z.string().nullable(),
    other: z.array(z.string())
  })
  .catchall(z.unknown());

export function fieldSchema(kind: FieldKind | undefined): z.ZodTypeAny {
  switch (kind) {
    case "stringArray":
      return z.array(z.string());
    case "number":
      return z.number().nullable();
    case "boolean":
      return z.boolean().nullable();
    case "object":
      return z.record(z.unknown()).nullable();
    case "string":
    default:
      return z.string().nullable();
  }
}

export function createProductSchema(fields: Record<string, FieldConfig>): z.ZodType<ProductRecord> {
  const shape: Record<string, z.ZodTypeAny> = {
    category: z.string().nullable(),
    subcategory: z.string().nullable(),
    name: z.string().nullable(),
    abbreviation: z.string().nullable(),
    collisage: z.string().nullable(),
    model: z.string().nullable(),
    brand: z.string().nullable(),
    serie: z.string().nullable(),
    quality: z.string().nullable(),
    material: z.string().nullable(),
    dims: z.array(z.string()),
    color: z.string().nullable(),
    ref: z.string().nullable(),
    other: z.array(z.string())
  };

  for (const [name, definition] of Object.entries(fields)) {
    if (!(name in shape)) shape[name] = fieldSchema(definition.kind);
  }
  return z.object(shape).catchall(z.unknown()) as unknown as z.ZodType<ProductRecord>;
}

export function emptyProduct(fields: Record<string, FieldConfig> = {}): ProductRecord {
  const product: ProductRecord = {
    category: null,
    subcategory: null,
    name: null,
    abbreviation: null,
    collisage: null,
    model: null,
    brand: null,
    serie: null,
    quality: null,
    material: null,
    dims: [],
    color: null,
    ref: null,
    other: []
  };

  for (const [name, definition] of Object.entries(fields)) {
    if (name in product) continue;
    product[name] = definition.defaultValue ?? (definition.kind === "stringArray" ? [] : null);
  }
  return product;
}
