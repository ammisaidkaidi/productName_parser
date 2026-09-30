import { describe, expect, it } from "vitest";
import { Normalizer, normalizeScalar, preNormalize } from "../src/normalization/index.js";
import { exampleConfig } from "../examples/config.js";

describe("normalization", () => {
  it("normalizes spacing without changing the raw input", () => {
    expect(preNormalize("Réf: RA-12   1 / 2", exampleConfig)).toBe("Réf: RA-12 1/2");
    expect(preNormalize("JEUX Coude 110 x 3.2", exampleConfig)).toBe("JEUX Coude 110x3.2");
  });

  it("uses configured aliases and does not use generic material inference", () => {
    expect(normalizeScalar("BRASS", exampleConfig.fields.material, "material", exampleConfig)).toBe("laiton");
    const normalizer = new Normalizer(exampleConfig);
    const result = normalizer.normalizeProduct({ material: null, dims: [], ref: null });
    expect(result.material).toBeNull();
  });

  it("keeps reference punctuation and canonicalizes configured values", () => {
    const normalizer = new Normalizer(exampleConfig);
    const result = normalizer.normalizeProduct({ ...normalizer.normalizeProduct({}), ref: "RA-12", material: "BRASS" });
    expect(result.ref).toBe("RA-12");
    expect(result.material).toBe("laiton");
  });
});
