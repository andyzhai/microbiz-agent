import { z } from "zod";
import { AdapterError, createGateway } from "./gateway.js";
import type { Capability, GatewayLimits, ModelAdapter } from "./gateway.js";
import { OPENROUTER, roles, validModelRoles } from "./policy.js";
import type { ModelRequest } from "./policy.js";
import { toolProposalSchema } from "./tools.js";

const rejection = z.object({
  code: z.number().int().optional(), message: z.string().optional(),
  metadata: z.object({ error_type: z.string().optional(), raw: z.string().optional() }).optional(),
});
function providerError(status: number, detail?: z.infer<typeof rejection>): Error {
  if ([400, 404, 422].includes(status)) {
    const incompatible = [detail?.message, detail?.metadata?.raw].some(text => text &&
      /structured[ _-]outputs?|response_format|json_schema|tool[s_ -]?\b|tool_choice|function calling/i.test(text) &&
      /unsupported|not support|doesn't support|not available|no endpoints? (?:found|support)/i.test(text));
    if (incompatible || detail?.metadata?.error_type === "context_length_exceeded") return new AdapterError("capability_unavailable");
  }
  if (status === 429) return new AdapterError("rate_limited");
  if (status === 404 || status === 408 || status >= 500) {
    return new AdapterError("provider_unavailable");
  }
  return new Error("Provider rejected request");
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  if ((!response.ok && ![400, 404, 422].includes(response.status)) || !response.body) {
    await response.body?.cancel();
    throw providerError(response.status);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) {
        await reader.cancel();
        throw new AdapterError("output_too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("provider_unavailable");
  } finally {
    reader.releaseLock();
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw response.ok ? new AdapterError("invalid_output") : providerError(response.status); }
  if (!response.ok) {
    const parsed = z.object({ error: rejection }).safeParse(raw);
    throw providerError(response.status, parsed.data?.error);
  }
  return raw;
}

const catalogEntry = z.object({
  id: z.string(), pricing: z.record(z.string(), z.string()), supported_parameters: z.array(z.string()),
  context_length: z.number().int().positive(), top_provider: z.object({ max_completion_tokens: z.number().int().positive().nullable() }),
  reasoning: z.object({ mandatory: z.boolean().optional() }).nullish(),
});
function capabilities(raw: unknown, optionalReasoning: Set<string>) {
  const { data } = z.object({ data: z.array(z.unknown()) }).parse(raw);
  const available = new Map<string, Capability>();
  for (const item of data) {
    const parsed = catalogEntry.safeParse(item);
    if (!parsed.success) continue;
    const row = parsed.data;
    const free = /^0(?:\.0+)?$/;
    if (!Object.values<string>(roles).includes(row.id) || !free.test(row.pricing.prompt ?? "") ||
        !free.test(row.pricing.completion ?? "") || Object.values(row.pricing).some(price => !free.test(price))) continue;
    const params = row.supported_parameters;
    if (row.reasoning?.mandatory === false && params.includes("reasoning")) optionalReasoning.add(row.id);
    available.set(row.id, {
      structured: params.includes("structured_outputs") && params.includes("response_format"),
      tools: params.includes("tools") && params.includes("tool_choice"),
      contextTokens: row.context_length, outputTokens: row.top_provider.max_completion_tokens ?? 0,
    });
  }
  return available;
}

function payload(model: string, req: ModelRequest, disableReasoning: boolean, maxTokens: number) {
  const messages: unknown[] = [
    { role: "system", content: req.instruction.content },
    { role: "user", content: JSON.stringify(req.sources.map(({ id, content }) => ({ id, content }))) },
  ];
  if (req.exchange) {
    const { name, argumentsJson, resultJson } = req.exchange;
    const call = { id: "lookup001", type: "function", function: { name, arguments: argumentsJson } };
    messages.push({ role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: resultJson });
  }
  return {
    model, messages, ...(req.instruction.responseFormat ? { response_format: JSON.parse(req.instruction.responseFormat) } : {}),
    ...(req.instruction.tools === "[]" ? {} : { tools: JSON.parse(req.instruction.tools), tool_choice: req.exchange ? "none" : "auto" }),
    max_tokens: maxTokens,
    ...(disableReasoning ? { reasoning: { enabled: false } } : {}),
    provider: { require_parameters: true, allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0 } },
  };
}

const completion = z.object({
  choices: z.tuple([z.object({
    finish_reason: z.enum(["stop", "tool_calls"]),
    message: z.object({
      content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({ type: z.literal("function"),
        function: z.object({ name: z.string(), arguments: z.string() }) })).max(1).nullish(),
    }),
  })]),
});
function decodeReply(raw: unknown): unknown {
  const envelope = z.object({ error: rejection }).safeParse(raw);
  const interrupted = z.object({ choices: z.tuple([z.object({ finish_reason: z.literal("error"), error: rejection })]) }).safeParse(raw);
  const error = envelope.data?.error ?? interrupted.data?.choices[0].error;
  if (error) throw providerError(error.code ?? 400, error);
  const reply = completion.safeParse(raw);
  if (!reply.success) throw new AdapterError("invalid_output");
  const { message, finish_reason } = reply.data.choices[0];
  try {
    const call = message.tool_calls?.[0];
    if (finish_reason === "tool_calls" && call) return { name: call.function.name, arguments: JSON.parse(call.function.arguments) };
    if (finish_reason === "stop" && !call && message.content) {
      const content: unknown = JSON.parse(message.content);
      // Only a native tool call can initiate a lookup on the live path.
      if (!toolProposalSchema.safeParse(content).success) return content;
    }
  } catch { /* Malformed provider JSON uses the same bounded repair as invalid schema. */ }
  throw new AdapterError("invalid_output");
}

export function openRouterGateway(key: string, transport = fetch, options: Partial<GatewayLimits> & { onlyRole?: keyof typeof roles } = {}) {
  if (!key.trim()) throw new Error("Missing OpenRouter key");
  if (!validModelRoles(roles)) throw new Error("Set LOCAL_MODEL and CLOUD_MODEL to two distinct provider/model:free IDs.");
  const maxTokens = Number(process.env.OPENROUTER_MAX_TOKENS ?? 10_000);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("OPENROUTER_MAX_TOKENS must be a positive safe integer.");
  async function send(url: string, init: RequestInit, cap: number) {
    let response;
    try { response = await transport(url, { ...init, redirect: "error" }); }
    catch { throw new AdapterError("provider_unavailable"); }
    return readJson(response, cap);
  }
  const { onlyRole, ...limits } = options;
  const optionalReasoning = new Set<string>();
  const models = Object.entries(roles).filter(([role]) => onlyRole === undefined || role === onlyRole);
  const candidates = models.map(([, model]): ModelAdapter => {
    const destination = Object.freeze({ model, location: "external" as const, endpoint: OPENROUTER + "/chat/completions" });
    return {
      destination,
      // Include the optional parameter in the size bound even before catalog discovery.
      inputBytes: req => Buffer.byteLength(JSON.stringify(payload(model, req, true, maxTokens))),
      async generate(req, signal, usage) {
        const raw = await send(destination.endpoint, {
          method: "POST", signal, body: JSON.stringify(payload(model, req, optionalReasoning.has(model), maxTokens)),
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        }, 32_768);
        const tokens = z.object({ usage: z.object({ total_tokens: z.number().int().nonnegative() }) }).safeParse(raw);
        if (tokens.success) usage?.(tokens.data.usage.total_tokens);
        return decodeReply(raw);
      },
    };
  });
  return createGateway({
    candidates,
    maxOutputTokens: maxTokens,
    allowRepair: onlyRole === undefined,
    async probe(signal) { return capabilities(await send(OPENROUTER + "/models", { signal }, 4_194_304), optionalReasoning); },
  }, limits);
}
