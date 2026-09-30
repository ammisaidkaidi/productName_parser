import type {
  LLMMessage,
  LLMProvider,
  LLMToolCall,
  LLMToolDefinition,
  LLMToolResponse,
  StructuredGenerationRequest,
  ToolGenerationRequest
} from "./provider.js";
import { parseJsonContent } from "./provider.js";

export interface QwenProviderOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
    };
    finish_reason?: string;
  }>;
}

/**
 * Adapter for local Qwen servers exposing an OpenAI-compatible chat-completions
 * endpoint. The endpoint is injected, so no Ollama or cloud service is assumed.
 */
export class QwenProvider implements LLMProvider {
  readonly modelName: string;
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: QwenProviderOptions) {
    this.endpoint = options.endpoint;
    this.modelName = options.model;
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
  }

  async generateStructured(request: StructuredGenerationRequest): Promise<unknown> {
    const response = await this.request({
      ...request,
      tools: [],
      structuredOnly: true
    });
    return response.output;
  }

  async generateWithTools(request: ToolGenerationRequest): Promise<LLMToolResponse> {
    return this.request({ ...request, structuredOnly: false });
  }

  private async request(input: ToolGenerationRequest & { structuredOnly: boolean }): Promise<LLMToolResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? this.defaultTimeoutMs);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...this.headers
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

      const body: Record<string, unknown> = {
        model: input.model ?? this.modelName,
        messages: input.messages.map(toOpenAIMessage),
        temperature: input.temperature ?? 0,
        stream: false
      };
      if (!input.structuredOnly && input.tools.length > 0) {
        body.tools = input.tools.map(toOpenAITool);
        body.tool_choice = "auto";
      }
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "parsed_product", strict: true, schema: input.schema }
      };

      const result = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!result.ok) {
        const message = await result.text();
        throw new Error(`Qwen endpoint returned ${result.status}: ${message.slice(0, 500)}`);
      }
      const payload = (await result.json()) as OpenAIResponse;
      const choice = payload.choices?.[0];
      if (!choice?.message) throw new Error("Qwen response did not contain choices[0].message");

      const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).flatMap((call, index) => {
        const name = call.function?.name;
        if (!name) return [];
        const id = call.id ?? `qwen-tool-${index}`;
        const argumentsValue = parseJsonContent(call.function?.arguments ?? {});
        return [{ id, name, arguments: argumentsValue }];
      });
      const output = choice.message.content === undefined ? undefined : parseJsonContent(choice.message.content);
      return { output, toolCalls, raw: payload, finishReason: choice.finish_reason };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  const converted: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCallId) converted.tool_call_id = message.toolCallId;
  if (message.name) converted.name = message.name;
  if (message.toolCalls) {
    converted.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) }
    }));
  }
  return converted;
}

function toOpenAITool(tool: LLMToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  };
}

export function qwenMessage(role: LLMMessage["role"], content: string): LLMMessage {
  return { role, content };
}
