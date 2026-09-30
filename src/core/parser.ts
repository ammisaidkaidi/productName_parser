import type { LLMProvider, LLMMessage, LLMToolResponse } from "../llm/provider.js";
import type { ParserTool, ToolCallRecord } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { createResolveProductTermTool } from "../tools/resolver.js";
import { mergeParserConfig, type ParserConfig } from "../schema/config.js";
import { createProductSchema, emptyProduct, type FieldDecisions, type ProductRecord } from "../schema/product.js";
import { Normalizer } from "../normalization/normalizer.js";
import { PromptBuilder, type BuiltPrompt } from "./prompt-builder.js";
import { confidenceAction, overallConfidence } from "./confidence.js";
import { heuristicExtract, mergeDecisionsIntoData, parseExtractionEnvelope, validateBusinessRules, type ExtractionEnvelope } from "./pipeline.js";

export interface ParserOptions {
  llm?: LLMProvider;
  config?: Partial<ParserConfig>;
  tools?: ParserTool[];
  debug?: boolean;
}

export interface ParseOptions {
  debug?: boolean;
  includeFieldDetails?: boolean;
}

export interface BatchOptions extends ParseOptions {
  concurrency?: number;
}

export interface DebugTrace {
  rawInput: string;
  normalizedInput: string;
  llmRequests: Array<{ messages: LLMMessage[]; schema: unknown; tools: unknown[] }>;
  llmResponses: unknown[];
  toolCalls: ToolCallRecord[];
  validationErrors: string[];
  fieldDecisions: FieldDecisions;
  finalOutput?: ProductRecord;
  timings: Record<string, number>;
}

export interface ParserMetadata {
  confidence: number;
  toolsUsed: string[];
  warnings: string[];
  processingTimeMs: number;
  modelName?: string;
  rawInput?: string;
  normalizedInput?: string;
  fieldConfidence?: Record<string, { confidence: number; source: string; ambiguous: boolean }>;
  debug?: DebugTrace;
}

export interface ParseResult<T extends ProductRecord = ProductRecord> {
  data: T;
  metadata: ParserMetadata;
}

export class ProductParser {
  readonly config: ParserConfig;
  readonly tools: ToolRegistry;
  private readonly llm?: LLMProvider;
  private readonly normalizer: Normalizer;
  private readonly promptBuilder = new PromptBuilder();

  constructor(options: ParserOptions = {}) {
    this.config = mergeParserConfig(options.config);
    this.llm = options.llm;
    this.normalizer = new Normalizer(this.config);
    this.tools = new ToolRegistry();
    this.tools.register(createResolveProductTermTool(this.config));
    for (const tool of options.tools ?? []) this.tools.registerOrReplace(tool);
    this.defaultDebug = options.debug ?? false;
  }

  private readonly defaultDebug: boolean;

  registerTool(tool: ParserTool): this {
    this.tools.registerOrReplace(tool);
    return this;
  }

  unregisterTool(name: string): boolean {
    if (name === "resolveProductTerm") return false;
    return this.tools.unregister(name);
  }

  async parse(input: string, options: ParseOptions = {}): Promise<ParseResult> {
    if (typeof input !== "string") throw new TypeError("ProductParser.parse expects a string");
    const started = Date.now();
    const debugEnabled = options.debug ?? this.defaultDebug;
    const normalizedInput = this.normalizer.preNormalize(input);
    const trace: DebugTrace = {
      rawInput: input,
      normalizedInput,
      llmRequests: [],
      llmResponses: [],
      toolCalls: [],
      validationErrors: [],
      fieldDecisions: {},
      timings: {}
    };
    const warnings: string[] = [];
    const toolsUsed = new Set<string>();
    const prompt = this.promptBuilder.build({ input, normalizedInput, config: this.config, tools: this.tools.definitions() });
    const extractionStarted = Date.now();
    let envelope: ExtractionEnvelope;
    let llmFailed = false;

    if (this.llm) {
      try {
        envelope = await this.generateWithRetries(prompt, trace, toolsUsed);
      } catch (error) {
        llmFailed = true;
        warnings.push(`LLM extraction failed after bounded retries: ${error instanceof Error ? error.message : String(error)}`);
        envelope = heuristicExtract(input, normalizedInput, this.config);
        warnings.push("Used deterministic catalog parser fallback; no unsupported values were added.");
      }
    } else {
      // Deterministic extraction is a supported offline mode, not an error.
      // The active mode remains visible through metadata.modelName.
      envelope = heuristicExtract(input, normalizedInput, this.config);
    }
    trace.timings.extractionMs = Date.now() - extractionStarted;

    const toolStarted = Date.now();
    await this.resolveAmbiguities(envelope, toolsUsed, trace, warnings);
    trace.timings.toolsMs = Date.now() - toolStarted;

    let data = mergeDecisionsIntoData(envelope, this.config, this.normalizer);
    const schemaResult = createProductSchema(this.config.fields).safeParse(data);
    if (!schemaResult.success) {
      const message = `Final schema validation failed: ${schemaResult.error.issues.map((issue) => issue.path.join(".") + " " + issue.message).join("; ")}`;
      warnings.push(message);
      trace.validationErrors.push(message);
      data = emptyProduct(this.config.fields);
    }
    const businessErrors = validateBusinessRules(data, this.config);
    if (businessErrors.length > 0) {
      warnings.push(...businessErrors.map((error) => `Business validation: ${error}`));
      trace.validationErrors.push(...businessErrors);
    }
    trace.fieldDecisions = envelope.fields;
    trace.finalOutput = data;
    trace.timings.totalMs = Date.now() - started;

    const metadata: ParserMetadata = {
      confidence: overallConfidence(envelope.fields),
      toolsUsed: [...toolsUsed],
      warnings,
      processingTimeMs: Date.now() - started
    };
    const modelName = this.llm?.modelName ?? this.config.modelName;
    if (modelName) metadata.modelName = modelName;
    // Keep both representations in metadata; debug mode adds execution details,
    // but the original description is never discarded in either mode.
    metadata.rawInput = input;
    metadata.normalizedInput = normalizedInput;
    if (debugEnabled) metadata.debug = trace;
    if (options.includeFieldDetails || debugEnabled) {
      metadata.fieldConfidence = Object.fromEntries(Object.entries(envelope.fields).map(([name, value]) => [name, {
        confidence: value.confidence,
        source: value.source,
        ambiguous: value.ambiguous
      }]));
    }
    if (llmFailed) trace.timings.llmFallback = 1;
    return { data, metadata };
  }

  async parseBatch(inputs: string[], options: BatchOptions = {}): Promise<ParseResult[]> {
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? this.config.concurrency));
    const results: ParseResult[] = new Array(inputs.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = next++;
        if (index >= inputs.length) return;
        results[index] = await this.parse(inputs[index]!, options);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(inputs.length, 1)) }, () => worker()));
    return results;
  }

  private async generateWithRetries(prompt: BuiltPrompt, trace: DebugTrace, toolsUsed: Set<string>): Promise<ExtractionEnvelope> {
    if (!this.llm) throw new Error("No LLM provider configured");
    let messages = [...prompt.messages];
    let lastError: unknown;
    let totalToolCalls = 0;
    const attempts = this.config.retry.maxRetries + 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const toolDefinitions = this.tools.definitions();
        trace.llmRequests.push({ messages: [...messages], schema: prompt.outputSchema, tools: toolDefinitions });
        const response = await this.llm.generateWithTools({
          messages,
          schema: prompt.outputSchema,
          tools: toolDefinitions,
          model: this.llm.modelName ?? this.config.modelName,
          temperature: 0,
          timeoutMs: this.config.retry.timeoutMs
        });
        trace.llmResponses.push(response.raw ?? response.output);
        if (response.toolCalls && response.toolCalls.length > 0) {
          const toolMessages: LLMMessage[] = [{
            role: "assistant",
            content: "",
            toolCalls: response.toolCalls
          }];
          for (const call of response.toolCalls) {
            totalToolCalls += 1;
            if (totalToolCalls > this.config.retry.maxToolCalls) throw new Error("Maximum tool calls exceeded");
            const toolResult = await this.executeTool(call.name, call.arguments, trace, toolsUsed);
            toolMessages.push({ role: "tool", content: safeJson(toolResult), toolCallId: call.id, name: call.name });
          }
          messages = [...messages, ...toolMessages];
          continue;
        }
        if (response.output === undefined) throw new Error("LLM returned neither structured output nor a tool call");
        return parseExtractionEnvelope(response.output, this.config, this.normalizer);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        trace.validationErrors.push(`attempt ${attempt + 1}: ${message}`);
        if (attempt + 1 >= attempts) break;
        messages = [
          ...prompt.messages,
          { role: "user", content: `The previous response was invalid. Return only valid JSON matching the supplied schema. Validation error: ${message}` }
        ];
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "LLM extraction failed"));
  }

  private async resolveAmbiguities(envelope: ExtractionEnvelope, toolsUsed: Set<string>, trace: DebugTrace, warnings: string[]): Promise<void> {
    const resolver = this.tools.get("resolveProductTerm");
    if (!resolver || this.config.ambiguity.onAmbiguity === "null") {
      if (this.config.ambiguity.onAmbiguity === "null") warnings.push("Ambiguous values were left unresolved by configuration.");
      return;
    }
    let calls = 0;
    for (const [fieldName, decision] of Object.entries(envelope.fields)) {
      const action = confidenceAction(decision.confidence, decision.ambiguous, {
        ...this.config.confidence,
        ...(this.config.fields[fieldName]?.confidence ?? {})
      });
      if (action !== "tool") continue;
      if (calls >= this.config.retry.maxToolCalls) {
        warnings.push(`Tool budget exhausted before resolving ${fieldName}.`);
        continue;
      }
      const term = envelope.ambiguityTerms?.[fieldName] ?? (typeof decision.value === "string" ? decision.value : undefined);
      if (!term) continue;
      const candidatesHint = envelope.ambiguityTerms?.[`${fieldName}.__candidates`];
      const context = typeof envelope.data.brand === "string" ? envelope.data.brand : null;
      calls += 1;
      let result: unknown;
      try {
        result = await this.executeTool("resolveProductTerm", {
          term,
          context,
          candidateFields: candidatesHint?.split(",") ?? [fieldName]
        }, trace, toolsUsed, warnings);
      } catch {
        // Tool failures are bounded and become an unresolved field rather than a parser crash.
        envelope.data[fieldName] = Array.isArray(envelope.data[fieldName]) ? [] : null;
        envelope.fields[fieldName] = { value: null, confidence: 0, source: "tool", ambiguous: true };
        continue;
      }
      if (!result || typeof result !== "object") {
        warnings.push(`resolveProductTerm returned an invalid response for ${fieldName}.`);
        continue;
      }
      const resolved = result as { status?: string; field?: string; value?: unknown; confidence?: number; candidates?: unknown[] };
      if (resolved.status === "resolved" && resolved.field && resolved.value !== undefined && resolved.field in envelope.fields) {
        envelope.data[resolved.field] = resolved.value;
        envelope.fields[resolved.field] = {
          value: resolved.value,
          confidence: typeof resolved.confidence === "number" ? resolved.confidence : 0.98,
          source: "tool",
          ambiguous: false
        };
        continue;
      }
      envelope.data[fieldName] = Array.isArray(envelope.data[fieldName]) ? [] : null;
      envelope.fields[fieldName] = { value: null, confidence: Math.min(decision.confidence, 0.49), source: "tool", ambiguous: true };
      warnings.push(`Unresolved ambiguity for ${fieldName}${resolved.candidates ? ` (${resolved.candidates.length} candidates)` : ""}.`);
    }
  }

  private async executeTool(name: string, input: unknown, trace: DebugTrace, toolsUsed: Set<string>, warnings: string[] = []): Promise<unknown> {
    const started = Date.now();
    const record: ToolCallRecord = { name, input, durationMs: 0 };
    toolsUsed.add(name);
    try {
      const output = await withTimeout(this.tools.execute(name, input), this.config.retry.timeoutMs);
      record.output = output;
      record.durationMs = Date.now() - started;
      trace.toolCalls.push(record);
      return output;
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      record.durationMs = Date.now() - started;
      trace.toolCalls.push(record);
      warnings.push(`Tool ${name} failed: ${record.error}`);
      throw error;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify({ error: "Tool result was not JSON serializable" }); }
}
