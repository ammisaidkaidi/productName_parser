import type { ParserConfig } from "../src/schema/config.js";
import { DEFAULT_FIELD_CONFIG } from "../src/schema/config.js";

/** The administrator-owned category taxonomy used by the demo. */
export const exampleTaxonomy = {
  plomberie: ["pvc", "bronze", "robinet", "pehd", "pex", "cuivre", "raccord", "vanne", "flexible", "siphon", "évacuation", "alimentation"],
  "électricité": ["câble", "fil", "disjoncteur", "interrupteur", "prise", "tableau", "gaine", "boîte", "éclairage", "appareillage"],
  quincaillerie: ["vis", "boulon", "écrou", "rondelle", "cheville", "clou", "charnière", "serrure", "poignée", "cadenas"],
  peinture: ["peinture", "sous-couche", "vernis", "enduit", "diluant", "solvant", "silicone", "colle"],
  droguerie: ["adhésif", "colle", "mastic", "silicone", "mousse", "abrasif", "nettoyage", "entretien"],
  chauffage: ["chaudière", "radiateur", "vanne", "circulateur", "vase_expansion", "purgeur", "thermostat", "raccord", "tube", "cheminée"],
  outillage: ["perceuse", "meuleuse", "visseuse", "marteau", "pince", "tournevis", "clé", "scie", "mètre", "niveau"],
  construction: ["ciment", "mortier", "plâtre", "béton", "sable", "gravier", "ferraillage", "étanchéité"],
  // Explicit extension for computer products not covered by the initial building-supply taxonomy.
  informatique: ["pc portable", "ordinateur", "ordinateur portable", "laptop"]
} as const;

const categoryAliases: Record<string, string[]> = {
  "électricité": ["electricite"],
  quincaillerie: ["quincaillerie"],
  plomberie: ["plomberie"],
  peinture: ["peinture"],
  droguerie: ["droguerie"],
  chauffage: ["chauffage"],
  outillage: ["outillage"],
  construction: ["construction"]
};

// Keep one canonical category relationship for duplicate terms such as vanne,
// raccord, colle, and silicone. Explicit category text remains authoritative.
const taxonomySubcategories = [...new Map(
  Object.entries(exampleTaxonomy).flatMap(([category, values]) => values.map((name) => [name, { name, category }] as const))
).values()].map((item) => ({ name: item.name, category: item.category }));

/** A deliberately small, administrator-owned catalog. It is not baked into the parser. */
export const exampleConfig: ParserConfig = {
  brands: [
    {
      name: "Somatherm",
      aliases: ["somatherm", "soma therm", "somathrm"],
      series: [
        { name: "Pro", aliases: ["pro"] },
        { name: "Premium", aliases: ["premium"] }
      ]
    },
    {
      name: "Borsan",
      aliases: ["borsan"],
      series: ["Standard", "Plus"]
    },
    {
      name: "HP",
      aliases: ["hp"],
      series: [{ name: "Pavilion", aliases: ["pavilion", "pavillon"] }]
    }
  ],
  categories: Object.keys(exampleTaxonomy).map((name) => ({ name, aliases: categoryAliases[name] ?? [] })),
  subcategories: taxonomySubcategories,
  fields: {
    ...DEFAULT_FIELD_CONFIG,
    name: {
      kind: "string",
      description: "Canonical product name, retaining product-specific terminology.",
      allowedValues: ["robinet d'arrêt", "tube", "coude", "pc portable"],
      aliases: {
        "robinet arret": "robinet d'arrêt",
        "robinet arrêt": "robinet d'arrêt",
        "rob arrêt": "robinet d'arrêt",
        "rob arret": "robinet d'arrêt",
        robinet: "robinet d'arrêt",
        elbow: "coude",
        coudes: "coude",
        pc: "pc portable",
        "pc portable": "pc portable",
        "ordinateur portable": "pc portable"
      },
      instructions: ["Do not expand abbreviations unless a configured alias authorizes it."]
    },
    model: {
      kind: "string",
      description: "Product model code.",
      normalization: [{ type: "uppercase" }],
      extract: {
        patterns: ["\\b(DV\\d+[A-Z]?)\\b"],
        flags: "i",
        captureGroup: 1
      }
    },
    material: {
      kind: "string",
      description: "Explicit material only.",
      allowedValues: ["laiton", "bronze", "pvc", "pehd", "pex", "cuivre"],
      aliases: { brass: "laiton", lait: "laiton", pvc: "pvc" },
      instructions: ["Never infer material from product category or brand."]
    },
    color: {
      kind: "string",
      allowedValues: ["gris", "noir", "blanc"],
      aliases: { grey: "gris", gray: "gris" }
    },
    quality: {
      kind: "string",
      allowedValues: ["standard", "premium"]
    },
    ref: {
      kind: "string",
      description: "Product reference / manufacturer reference.",
      instructions: [
        "Usually contains letters and numbers.",
        "May contain hyphens, slashes, or underscores.",
        "Must not be confused with dimensions.",
        "Prefer explicit markers such as REF, Réf, or Reference.",
        "Do not invent a reference."
      ],
      examples: ["RA12", "ABC-120", "REF12345"],
      extract: {
        patterns: ["\\b(?:REF|RÉF|REFERENCE)\\s*[:#]?\\s*([A-Z0-9][A-Z0-9/_-]*)"],
        flags: "i",
        captureGroup: 1
      }
    },
    dims: {
      kind: "stringArray",
      description: "Physical dimensions, connection sizes, diameters, lengths, widths, and angles.",
      instructions: [
        "Preserve the original numeric value.",
        "Recognize units and angles such as 45deg or 45°.",
        "Recognize forms such as 1/2, 3/4, M8, 110x50, and 4x35.",
        "Do not confuse product references with dimensions."
      ],
      examples: ["1/2", "3/4", "M8", "110x3.2", "110mm", "45deg", "4m"],
      extract: {
        contextTerms: ["tube", "tuyau", "coude", "dn", "diam", "diamètre", "diameter", "dimension", "longueur", "largeur", "hauteur", "ø"]
      }
    }
  },
  normalization: {
    unicodeNormalize: "NFKC",
    rules: []
  },
  confidence: {
    autoAccept: 0.9,
    requireTool: 0.75,
    rejectBelow: 0.5
  },
  ambiguity: {
    onAmbiguity: "tool",
    maxCandidates: 8
  },
  retry: {
    maxRetries: 2,
    maxToolCalls: 3,
    timeoutMs: 10_000
  },
  concurrency: 4,
  modelName: "local-qwen-or-deterministic-fallback"
};
