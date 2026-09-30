import { describe, expect, it } from "vitest";
import { ProductParser } from "../src/index.js";
import { exampleConfig } from "../examples/config.js";

describe("demo test cases", () => {
  const cases = [
    ["Robinet d'arrêt laiton 1/2 Somatherm Pro RA12", { brand: "Somatherm", serie: "Pro", material: "laiton", dims: ["1/2"] }],
    ["Rob arrêt lait MF 1/2 Somatherm", { brand: "Somatherm", material: "laiton", dims: ["1/2"] }],
    ["Tube PVC 110 x 3.2 gris", { material: "pvc", color: "gris", dims: ["110x3.2"] }],
    ["Coude PVC 110", { category: "plomberie", subcategory: "pvc", name: "coude", material: "pvc", dims: ["110"] }],
    ["1pcs pvc coude 110mm 45deg gris", { category: "plomberie", subcategory: "pvc", name: "coude", collisage: "1pcs", material: "pvc", dims: ["110mm", "45deg"], color: "gris" }],
    ["Robinet ABC110", { ref: null, model: null }],
    ["Robinet Pro 1/2", { brand: null, serie: null, dims: ["1/2"] }],
    ["robinet arret somathrm 1/2", { brand: "Somatherm", dims: ["1/2"] }],
    ["Robinet 1/2", { brand: null, material: null, dims: ["1/2"] }],
    ["Tube PVC 110x3.2 longueur 4m", { dims: ["110x3.2", "4m"] }],
    ["Somatherm Pro robinet arrêt 1/2", { brand: "Somatherm", serie: "Pro", dims: ["1/2"] }]
  ] as const;

  it.each(cases)("parses %s without unsupported values", async (input, expected) => {
    const parser = new ProductParser({ config: exampleConfig });
    const result = await parser.parse(input);
    for (const [field, value] of Object.entries(expected)) expect(result.data[field]).toEqual(value);
  });
});
