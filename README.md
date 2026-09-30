# Product Parser

Production-oriented, offline-first TypeScript/Node.js library for extracting and normalizing structured product data from short descriptions. The library is model-agnostic and has an initial `QwenProvider` adapter for local OpenAI-compatible structured-output/tool-calling endpoints.

This project is intentionally limited to **product parsing and normalization**. It does not contain embeddings, semantic search, BM25, ranking, pgvector, or recommendations.

## Features

- Strongly typed canonical `ParsedProduct` schema with Zod runtime validation.
- Extensible configured fields: add fields without changing the parser pipeline.
- Dynamic brand → series catalog relationships and aliases.
- Configurable field instructions, examples, allowed values, extraction patterns, normalization, validation, inference policy, and thresholds.
- Deterministic pre-normalization and field normalization.
- Explicit distinction between `explicit`, `normalized`, `catalog`, `inferred`, and `tool` evidence.
- Field-level confidence and ambiguity state.
- Generic `ParserTool` interface and `ToolRegistry`.
- Bounded LLM retries, tool-call limits, and timeouts.
- Local-first: no network is required when using the deterministic catalog parser; the LLM endpoint is injectable.
- `parseBatch` with controlled concurrency.
- Structured debug traces without chain-of-thought.
- Standalone development demo and test suite.

## Installation

```bash
npm install
npm run build
npm test
```

The package targets Node.js 20+ and uses native `fetch`. The runtime dependency is only Zod; TypeScript, Vitest, and `tsx` are development dependencies.

## Basic usage

```ts
import { ProductParser } from "product-parser";
import { exampleConfig } from "./examples/config.js";

const parser = new ProductParser({ config: exampleConfig });

const result = await parser.parse(
  "ROBINET ARRET LAITON MF 1/2 SOMATHERM PRO REF RA12"
);

console.log(result.data);
// {
//   category: "plomberie",
//   subcategory: "robinet",
//   name: "robinet d'arrêt",
//   abbreviation: null,
//   collisage: null,
//   model: null,
//   brand: "Somatherm",
//   serie: "Pro",
//   quality: null,
//   madein: null,
//   material: "laiton",
//   dims: ["1/2"],
//   color: null,
//   ref: "RA12",
//   other: ["MF"]
// }

console.log(result.metadata.confidence);
console.log(result.metadata.toolsUsed);
```

When no LLM provider is supplied, the parser uses deterministic configured-catalog extraction. This fallback is useful for offline operation, tests, and high-confidence catalog terms. It never creates a value merely because it is common for a product category.

## Canonical schema

The initial schema is:

```ts
interface ParsedProduct {
  category: string | null;
  subcategory: string | null;
  name: string | null;
  abbreviation: string | null;
  collisage: string | null;
  model: string | null;
  brand: string | null;
  serie: string | null;
  quality: string | null;
  madein: string | null;
  material: string | null;
  dims: string[];
  color: string | null;
  ref: string | null;
  other: string[];
}
```

The actual runtime schema is extensible. Configured fields are added to the Zod schema and to the generated LLM JSON schema. New scalar fields default to `null`; `stringArray` fields default to `[]`.

## Configuration

The parser does not contain a product catalog. The application owns the catalog and passes it through configuration.

```ts
import type { ParserConfig } from "./src/schema/config.js";
import { DEFAULT_FIELD_CONFIG } from "./src/schema/config.js";

const config: ParserConfig = {
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
    }
  ],
  categories: [{ name: "plomberie", aliases: ["plumbing"] }],
  subcategories: [
    { name: "robinet", aliases: ["rob", "robinet arret"], category: "plomberie" }
  ],
  fields: {
    ...DEFAULT_FIELD_CONFIG,
    ref: {
      kind: "string",
      description: "Product reference / manufacturer reference.",
      instructions: [
        "Usually contains letters and numbers.",
        "May contain hyphens or slashes.",
        "Prefer explicit REF, Réf, or Reference markers.",
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
      description: "Physical dimensions, connection sizes, diameters, lengths, and widths.",
      instructions: [
        "Preserve numeric values and units.",
        "Recognize 1/2, 3/4, M8, 110x50, and 4x35.",
        "Do not confuse product references with dimensions."
      ]
    },
    material: {
      kind: "string",
      allowedValues: ["laiton", "pvc"],
      aliases: { brass: "laiton", lait: "laiton" },
      inference: { enabled: false }
    }
  },
  normalization: {
    unicodeNormalize: "NFKC",
    rules: []
  },
  confidence: {
    autoAccept: 0.90,
    requireTool: 0.75,
    rejectBelow: 0.50
  },
  ambiguity: { onAmbiguity: "tool", maxCandidates: 8 },
  retry: { maxRetries: 2, maxToolCalls: 3, timeoutMs: 10_000 },
  concurrency: 4
};
```

`examples/config.ts` contains the complete working configuration used by the demo and tests.

### Brand and series

A series is always associated with its configured brand. With `Somatherm Pro`, the parser can safely return both values. With only `Pro`, the parser does not guess the brand; it marks the term ambiguous and uses `resolveProductTerm`.

### Field instructions and rules

Each field can independently define:

- `description`, `instructions`, and `examples` included in the generated prompt.
- `allowedValues` and canonical `aliases`.
- `extract.patterns` with a configurable capture group.
- deterministic `normalization` rules (`map`, `replace`, `regex`, `trim`, `lowercase`, `uppercase`).
- runtime `validation` (`required`, length, regular expression).
- `inference.enabled` and administrator-supplied inference instructions.
- field-specific confidence thresholds.

The input remains available as `rawInput`. Pre-normalization produces a separate `normalizedInput` and never overwrites the original.

### Abbreviation and collisage prefixes

The canonical schema includes two configurable prefix fields:

- `abbreviation`: a configured abbreviation or conservative short all-capital prefix at the beginning, such as `COU`.
- `collisage`: a packaging/selling-unit prefix at the beginning, such as `1pcs`, `1kg`, `1kgrs`, `jeux`, `1dz`, `1m`, or `rlx`.

A numeric token such as `110` is extracted as a dimension when a configured context such as `tube`, `coude`, `DN`, `diamètre`, or `longueur` authorizes it. Without context, `ABC 110` remains ambiguous instead of being guessed as a dimension.

## Ambiguity and confidence

The parser does not assign an uncertain numeric token arbitrarily:

```text
ABC 110
```

A standalone `110` can be a dimension, model, reference, or series. The parser records ambiguity and uses the resolver tool. If the tool cannot resolve it, the corresponding field remains `null` or `[]`.

Thresholds are configurable:

```ts
confidence: {
  autoAccept: 0.90,
  requireTool: 0.75,
  rejectBelow: 0.50
}
```

- `>= autoAccept`: accept.
- `requireTool <= confidence < autoAccept`: validate or call a tool.
- `< rejectBelow`: reject to `null` / `[]`.
- `ambiguous: true`: tool or unresolved according to `ambiguity.onAmbiguity`.

Internal decisions have the form:

```ts
interface FieldResult<T> {
  value: T | null;
  confidence: number;
  source: "explicit" | "normalized" | "catalog" | "inferred" | "tool";
  ambiguous: boolean;
}
```

Set `debug: true` or `includeFieldDetails: true` to expose field decisions in metadata. Chain-of-thought is never returned.

## Tools and function calling

Tools are generic and dynamically exposed to the configured LLM:

```ts
import type { ParserTool } from "./src/index.js";

const lookupBrandTool: ParserTool = {
  name: "lookupBrand",
  description: "Verify a brand against an application-owned offline catalog.",
  inputSchema: {
    type: "object",
    properties: { term: { type: "string" } },
    required: ["term"]
  },
  async execute(input) {
    // Use an application-owned local lookup here.
    return { status: "unresolved", input };
  }
};

parser.registerTool(lookupBrandTool);
```

The built-in `resolveProductTerm` tool is registry-backed and understands configured brand/series relationships. Applications can register `lookupBrand`, `lookupSeries`, or domain-specific tools. Tool calls are bounded by `retry.maxToolCalls` and `retry.timeoutMs`. Tool failures become warnings and unresolved fields rather than uncaught parser failures.

## Local Qwen provider

`QwenProvider` targets an injected OpenAI-compatible chat-completions endpoint. It does not assume Ollama, OpenAI, internet access, or a cloud service:

```ts
import { ProductParser, QwenProvider } from "product-parser";

const llm = new QwenProvider({
  endpoint: "http://127.0.0.1:8080/v1/chat/completions",
  model: "Qwen2.5-3B-Instruct"
});

const parser = new ProductParser({ llm, config });
const result = await parser.parse("Tube PVC 110 x 3.2 gris");
```

The adapter sends `temperature: 0`, a generated JSON schema, and the registered tools. `generateWithTools` handles OpenAI-compatible `tool_calls`. The parser validates every final LLM response with Zod and retries malformed JSON/schema responses a bounded number of times before falling back to deterministic extraction.

To add another provider, implement:

```ts
interface LLMProvider {
  readonly modelName?: string;
  generateStructured(request: StructuredGenerationRequest): Promise<unknown>;
  generateWithTools(request: ToolGenerationRequest): Promise<LLMToolResponse>;
}
```

No parser pipeline code needs to change.

## Batch parsing

```ts
const results = await parser.parseBatch(productDescriptions, {
  concurrency: 4
});
```

Results retain input order while work is limited to the configured concurrency.

## Demo

Run the standalone HTTP demo:

```bash
npm run demo
```

Open `http://localhost:4173`. The server binds to `0.0.0.0`, so it also works in the Arena live preview. Without `QWEN_ENDPOINT`, it uses the actual deterministic parser library. To connect a local Qwen endpoint:

```bash
QWEN_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions \
QWEN_MODEL=Qwen2.5-3B-Instruct \
npm run demo
```

The UI calls `/api/parse`, renders the actual validated parser response, shows field confidence, tool-call history, warnings, raw/normalized input, latency, model/mode, and the active configuration. The **Edit configuration** modal can update categories/subcategories, brands/series, model regex rules, and per-property LLM descriptions, instructions, and examples. Saving posts the validated configuration to `/api/config` and rebuilds the active parser; **Reset demo config** restores the example configuration. It includes all requested test cases:

- clear product
- abbreviation
- dimensions
- reference ambiguity
- brand/series ambiguity
- typo
- missing information
- multiple dimensions
- brand + series

## Tests

```bash
npm test
npm run build
npm run check
```

Tests cover schema validation, normalization, catalog brand/series matching, reference and dimension extraction, ambiguity, thresholds, function calling, tool failures, retries, batching, configuration overrides, the Qwen adapter, and the full demo test set.

## Project structure

```text
product-parser/
├── src/
│   ├── core/             # parser, pipeline, prompt builder, confidence
│   ├── schema/           # Zod schema and configuration types
│   ├── llm/              # provider contract and Qwen adapter
│   ├── tools/            # generic registry and resolver
│   └── normalization/   # deterministic pre- and field-normalization
├── demo/                 # standalone HTTP server and inline HTML UI
├── tests/                # unit and integration tests
├── examples/             # working catalog configuration and example
├── package.json
└── tsconfig.json
```
