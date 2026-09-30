import { describe, expect, it } from "vitest";
import { ParsedProductSchema, createProductSchema } from "../src/schema/product.js";
import { mergeParserConfig } from "../src/schema/config.js";

const valid = {
  category: "plomberie", subcategory: "robinet", name: "robinet d'arrêt", abbreviation: null, collisage: null, model: null,
  brand: "Somatherm", serie: "Pro", quality: null, material: "laiton", dims: ["1/2"],
  color: null, ref: "RA12", other: ["MF"]
};

describe("runtime product schema", () => {
  it("accepts the canonical product shape", () => {
    expect(ParsedProductSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects malformed dimensions", () => {
    expect(ParsedProductSchema.safeParse({ ...valid, dims: "1/2" }).success).toBe(false);
  });

  it("adds configured fields to the runtime schema", () => {
    const config = mergeParserConfig({ fields: { warranty: { kind: "number" } } });
    expect(createProductSchema(config.fields).safeParse({ ...valid, warranty: 24 }).success).toBe(true);
    expect(createProductSchema(config.fields).safeParse({ ...valid, warranty: "24" }).success).toBe(false);
  });
});
