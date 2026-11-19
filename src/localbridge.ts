import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { incidentDocument } from "./incident-fixtures.js";
import type { Source } from "./policy.js";

export const microbizSandbox = "C:\\localbridge\\microbiz-sandbox";
const endpoint = "http://127.0.0.1:3001/mcp";
const protocol = "2026-07-28";
const toolName = "read_text_file";
const dialect = "https://json-schema.org/draft/2020-12/schema";
const inputSchema = { $schema: dialect, type: "object", required: ["path"], properties: {
  path: { type: "string" },
  tail: { type: "number", description: "If provided, returns only the last N lines of the file" },
  head: { type: "number", description: "If provided, returns only the first N lines of the file" },
} };
const outputSchema = { $schema: dialect, type: "object", required: ["content"],
  properties: { content: { type: "string" } }, additionalProperties: false };
const tool = z.object({ name: z.string(), inputSchema: z.unknown(), outputSchema: z.unknown(),
  annotations: z.unknown(), _meta: z.object({ securitySchemes: z.unknown() }).optional() });
const complete = z.object({ resultType: z.literal("complete"), _meta: z.object({
  "io.modelcontextprotocol/serverInfo": z.object({ name: z.literal("secure-filesystem-server"), version: z.literal("0.1.0") }),
}) });
const discovery = complete.extend({ supportedVersions: z.array(z.string()), capabilities: z.object({ tools: z.object({}) }) });
const catalog = complete.extend({ tools: z.array(z.object({ name: z.string() }).passthrough()).max(64), nextCursor: z.never().optional() });
const file = complete.extend({ isError: z.literal(false).optional(),
  content: z.tuple([z.object({ type: z.literal("text"), text: z.string() })]),
  structuredContent: z.strictObject({ content: z.string() }) });

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (response.status !== 200 || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
    await response.body?.cancel();
    throw new Error("LocalBridge request failed");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("LocalBridge response too large");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

// Only invoked after host authorization. The model has no control over the endpoint, tool or path.
export async function readLocalBridgeEvidence(source: Source) {
  const expected = incidentDocument(source);
  const signal = AbortSignal.timeout(5000);
  let id = 0;
  async function request(method: "server/discover" | "tools/list" | "tools/call", params: Record<string, unknown> = {}) {
    id++;
    const response = await fetch(endpoint, { method: "POST", redirect: "error", signal,
      headers: { Accept: "application/json, text/event-stream",
        "Content-Type": "application/json", "Mcp-Method": method, "MCP-Protocol-Version": protocol,
        ...(method === "tools/call" ? { "Mcp-Name": toolName } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: {
        "io.modelcontextprotocol/protocolVersion": protocol, "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "microbiz-agent", version: "1" },
      } } }) });
    const reply = await boundedJson(response, method === "tools/list" ? 64 * 1024 : 8 * 1024);
    return z.strictObject({ jsonrpc: z.literal("2.0"), id: z.literal(id), result: z.unknown() }).parse(reply).result;
  }
  const server = discovery.parse(await request("server/discover"));
  if (!server.supportedVersions.includes(protocol)) throw new Error("Unsupported LocalBridge protocol");
  const listed = catalog.parse(await request("tools/list")).tools.filter(entry => entry.name === toolName);
  const [read] = z.tuple([tool]).parse(listed);
  if (!isDeepStrictEqual(read.inputSchema, inputSchema) || !isDeepStrictEqual(read.outputSchema, outputSchema) ||
      !isDeepStrictEqual(read.annotations, { readOnlyHint: true, openWorldHint: false }) ||
      !isDeepStrictEqual(read._meta?.securitySchemes, [{ type: "noauth" }])) {
    throw new Error("Unexpected LocalBridge tool contract");
  }
  const path = win32.join(microbizSandbox, "incident-evidence", expected.fixtureId + ".json");
  const result = file.parse(await request("tools/call", { name: toolName, arguments: { path } }));
  const content = result.structuredContent.content;
  if (Buffer.byteLength(content) > 3072 || content !== result.content[0].text) throw new Error("Invalid evidence file");
  // A classification supplied by a filesystem server cannot establish synthetic provenance.
  const document = JSON.parse(content);
  if (!isDeepStrictEqual(document, expected)) throw new Error("Unreviewed evidence file");
  return document.evidence as typeof expected.evidence;
}
