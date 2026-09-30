export interface LLMAssistantToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: LLMAssistantToolCall[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface StructuredGenerationRequest {
  messages: LLMMessage[];
  schema: unknown;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
}

export interface ToolGenerationRequest extends StructuredGenerationRequest {
  tools: LLMToolDefinition[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LLMToolResponse {
  output?: unknown;
  toolCalls?: LLMToolCall[];
  raw?: unknown;
  finishReason?: string;
}

export interface LLMProvider {
  readonly modelName?: string;
  generateStructured(request: StructuredGenerationRequest): Promise<unknown>;
  generateWithTools(request: ToolGenerationRequest): Promise<LLMToolResponse>;
}

export function parseJsonContent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
