export interface ParserTool {
  name: string;
  description: string;
  inputSchema?: unknown;
  execute(input: unknown): Promise<unknown>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}
