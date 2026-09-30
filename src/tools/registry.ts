import type { LLMToolDefinition } from "../llm/provider.js";
import type { ParserTool } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ParserTool>();

  register(tool: ParserTool): this {
    if (!tool.name.trim()) throw new Error("A parser tool must have a name");
    if (this.tools.has(tool.name)) throw new Error(`A parser tool named ${tool.name} is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  registerOrReplace(tool: ParserTool): this {
    if (!tool.name.trim()) throw new Error("A parser tool must have a name");
    this.tools.set(tool.name, tool);
    return this;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ParserTool | undefined {
    return this.tools.get(name);
  }

  list(): ParserTool[] {
    return [...this.tools.values()];
  }

  definitions(): LLMToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true }
    }));
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown parser tool: ${name}`);
    return tool.execute(input);
  }
}
