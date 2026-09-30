import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProductParser, QwenProvider } from "../src/index.js";
import { mergeParserConfig, type ParserConfig } from "../src/schema/config.js";
import { exampleConfig } from "../examples/config.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const llm = process.env.QWEN_ENDPOINT
  ? new QwenProvider({
      endpoint: process.env.QWEN_ENDPOINT,
      model: process.env.QWEN_MODEL ?? "Qwen2.5-3B-Instruct",
      ...(process.env.QWEN_API_KEY ? { apiKey: process.env.QWEN_API_KEY } : {})
    })
  : undefined;
let activeConfig: ParserConfig = exampleConfig;
let parser = new ProductParser({ config: activeConfig, ...(llm ? { llm } : {}) });

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(here, "index.html"), "utf8");
      return send(response, 200, html, "text/html; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/api/config") {
      return sendJson(response, 200, { config: activeConfig, model: llm?.modelName ?? "deterministic fallback (no LLM configured)" });
    }
    if (request.method === "POST" && url.pathname === "/api/config") {
      const body = JSON.parse(await readBody(request)) as { config?: Partial<ParserConfig> };
      const candidate = body.config ?? body as Partial<ParserConfig>;
      activeConfig = mergeParserConfig(candidate);
      parser = new ProductParser({ config: activeConfig, ...(llm ? { llm } : {}) });
      return sendJson(response, 200, { config: activeConfig, model: llm?.modelName ?? "deterministic fallback (no LLM configured)" });
    }
    if (request.method === "POST" && url.pathname === "/api/config/reset") {
      activeConfig = mergeParserConfig(exampleConfig);
      parser = new ProductParser({ config: activeConfig, ...(llm ? { llm } : {}) });
      return sendJson(response, 200, { config: activeConfig, model: llm?.modelName ?? "deterministic fallback (no LLM configured)" });
    }
    if (request.method === "POST" && url.pathname === "/api/parse") {
      const body = JSON.parse(await readBody(request));
      if (typeof body.input !== "string") return sendJson(response, 400, { error: "input must be a string" });
      const result = await parser.parse(body.input, { debug: true, includeFieldDetails: true });
      return sendJson(response, 200, result);
    }
    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Product Parser demo listening on http://0.0.0.0:${port}`);
  console.log(llm ? `LLM adapter: ${llm.modelName}` : "LLM adapter: disabled; deterministic parser is active");
});

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  };
}

function send(response: import("node:http").ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, { ...corsHeaders(), "content-type": contentType });
  response.end(body);
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  send(response, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8");
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
