import { performance } from "node:perf_hooks";
import type { z } from "zod";
import { authorize } from "./policy.js";
import type { Destination, ModelRequest, PolicyReason, Source } from "./policy.js";
export type { ModelRequest } from "./policy.js";

export interface ModelAdapter {
  readonly destination: Destination;
  inputBytes?(request: ModelRequest): number;
  generate(request: ModelRequest, signal: AbortSignal, usage?: (tokens: number) => void): Promise<unknown>;
}
export interface Capability { structured: boolean; tools: boolean; contextTokens: number; outputTokens: number }
export interface Routes {
  readonly candidates: readonly ModelAdapter[];
  readonly maxOutputTokens: number;
  readonly allowRepair?: boolean;
  probe(signal: AbortSignal): Promise<ReadonlyMap<string, Capability>>;
}
export type GatewayReason = PolicyReason | "attempt_budget_exhausted" | "catalog_checked" | "capability_unavailable" |
  "input_too_large" | "output_too_large" | "invalid_output" | "adapter_failed" | "provider_unavailable" | "rate_limited" | "request_timeout";

export class AdapterError extends Error {
  constructor(readonly reason: "invalid_output" | "provider_unavailable" | "rate_limited" | "capability_unavailable" | "input_too_large" | "output_too_large") { super(reason); }
}
export interface Decision {
  readonly model: string;
  readonly location: Destination["location"] | "unknown";
  readonly route: "preferred" | "alternate" | "repair" | "catalog";
  readonly outcome: "completed" | "blocked" | "failed";
  readonly reason: GatewayReason;
  readonly attempts: number;
  readonly durationMs: number;
  readonly usage: number | "unknown";
}
export type GatewayResult<T> =
  | { status: "completed"; value: T; decision: Decision }
  | { status: "blocked" | "failed"; decision: Decision };

export interface GatewayLimits { maxAttempts: number; timeoutMs: number; maxInputBytes: number; maxOutputBytes: number }
export interface TaskGateway {
  readonly decisions: readonly Decision[];
  generate<T>(request: ModelRequest, schema: z.ZodType<T>): Promise<GatewayResult<T>>;
}
interface ChildScope {
  readonly task: ModelRequest["instruction"]["task"];
  readonly source: Source;
  remaining: number;
  readonly decisions: Decision[];
}
export const INPUT_BYTES = 8192;
const timeout = Symbol("timeout");

async function withTimeout<T>(ms: number, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(timeout); controller.abort(); }, ms);
  });
  try { return await Promise.race([deadline, send(controller.signal)]); }
  finally { clearTimeout(timer); }
}

export function createGateway(config: ModelAdapter | Routes, overrides: Partial<GatewayLimits> = {}) {
  const live = "candidates" in config;
  const limits = { maxAttempts: 4, timeoutMs: live ? 30_000 : 1000, maxInputBytes: INPUT_BYTES, maxOutputBytes: 8192, ...overrides };
  if (Object.values(limits).some(v => !Number.isSafeInteger(v) || v < 1) || limits.maxAttempts > 4)
    throw new Error("Invalid gateway limits");
  const candidates = (live ? config.candidates : [config]).map(adapter => ({
    destination: Object.freeze({ ...adapter.destination }), generate: adapter.generate.bind(adapter),
    inputBytes: adapter.inputBytes?.bind(adapter),
  }));
  if (!candidates.length) throw new Error("Missing model configuration");
  let attempts = 0;
  let rateLimited = false;
  const decisions: Decision[] = [];
  const unavailable = new Map<string, GatewayReason>();
  type Catalog = { capabilities: ReadonlyMap<string, Capability> } | { failure: Decision };
  let catalog: Promise<Catalog> | undefined;
  const reserve = (child?: ChildScope) => {
    if (child) child.remaining--;
    return ++attempts;
  };
  const exhausted = (child?: ChildScope) => attempts >= limits.maxAttempts || child?.remaining === 0;
  const record = (child: ChildScope | undefined, dest: Destination, route: Decision["route"], outcome: Decision["outcome"], reason: GatewayReason,
    ordinal: number, started: number, usage: Decision["usage"] = "unknown"): Decision => {
    const event = { model: reason === "destination_denied" ? "unapproved" : route === "catalog" ? "openrouter-catalog" : dest.model,
      location: reason === "destination_denied" ? "unknown" as const : dest.location,
      route, outcome, reason, attempts: ordinal, durationMs: Math.round(performance.now() - started), usage };
    decisions.push(event);
    child?.decisions.push(event);
    return event;
  };
  function probeOnce(routes: Routes, dest: Destination, child?: ChildScope): Promise<Catalog> {
    if (!catalog) {
      const ordinal = reserve(child);
      const started = performance.now();
      catalog = withTimeout(limits.timeoutMs, signal => routes.probe(signal)).then(capabilities => {
        record(child, dest, "catalog", "completed", "catalog_checked", ordinal, started);
        return { capabilities };
      }, error => {
        const reason = error === timeout ? "request_timeout" :
          error instanceof AdapterError && error.reason === "rate_limited" ? "rate_limited" : "provider_unavailable";
        if (reason === "rate_limited") rateLimited = true;
        return { failure: record(child, dest, "catalog", "failed", reason, ordinal, started) };
      });
    }
    return catalog;
  }

  async function generate<T>(request: ModelRequest, schema: z.ZodType<T>, child?: ChildScope): Promise<GatewayResult<T>> {
    // Only these fields have an authorized wire representation. Reject arbitrary history/attachments.
    const extra = !request || !Array.isArray(request.sources) || Object.keys(request).some(key => !["instruction","sources","exchange"].includes(key));
    const exchange = request?.exchange;
    const outbound = Object.freeze({ instruction: request?.instruction, sources: Object.freeze(extra ? [] : [...request.sources]),
      ...(exchange === undefined ? {} : { exchange }) });
    let last: GatewayResult<T> | undefined;
    for (const [index, adapter] of candidates.entries()) {
      const dest = adapter.destination;
      let route: Decision["route"] = index === 0 ? "preferred" : "alternate";
      for (;;) {
        const started = performance.now();
        const block = (reason: GatewayReason): GatewayResult<T> => ({ status: "blocked",
          decision: record(child, dest, route, "blocked", reason, attempts, started) });
        const permission = authorize(outbound, dest);
        if (permission === "destination_denied") return block(permission);
        if (extra || permission === "source_denied" || (child && (outbound.instruction.task !== child.task ||
            outbound.sources.length !== 1 || outbound.sources[0] !== child.source))) return block("source_denied");
        if (rateLimited) return block("rate_limited");
        const size = adapter.inputBytes?.(outbound) ?? Buffer.byteLength(JSON.stringify(outbound));
        if (size > limits.maxInputBytes) return block("input_too_large");
        if (exhausted(child)) return block("attempt_budget_exhausted");
        if (live) {
          const probe = await probeOnce(config, dest, child);
          if ("failure" in probe) {
            const failure = probe.failure;
            if (child && !child.decisions.includes(failure)) return block(failure.reason);
            return { status: "failed", decision: failure };
          }
          const capabilities = probe.capabilities.get(dest.model);
          const excluded = unavailable.get(dest.model);
          if (excluded) {
            const skipped = block(excluded);
            last ??= skipped;
            break;
          }
          // Estimate for the bundled English receipts and JSON schemas, including chat framing.
          const estimatedInputTokens = Math.ceil(size / 3) + 64;
          if (!capabilities?.structured ||
              (outbound.instruction.tools !== "[]" && !capabilities.tools) ||
              capabilities.contextTokens < estimatedInputTokens + config.maxOutputTokens || capabilities.outputTokens < config.maxOutputTokens) {
            const skipped = block("capability_unavailable");
            last ??= skipped;
            break;
          }
        } else if (dest.location !== "offline") return block("capability_unavailable");
        // No await between the final budget check and reservation.
        if (rateLimited) return block("rate_limited");
        if (exhausted(child)) return block("attempt_budget_exhausted");
        const ordinal = reserve(child);
        let usage: Decision["usage"] = "unknown";
        try {
          const raw = await withTimeout(limits.timeoutMs, signal => adapter.generate(outbound, signal, tokens => {
            if (Number.isSafeInteger(tokens) && tokens >= 0) usage = tokens;
          }));
          const serialized = JSON.stringify(raw);
          if (serialized && Buffer.byteLength(serialized) > limits.maxOutputBytes) throw new AdapterError("output_too_large");
          const parsed = schema.safeParse(raw);
          if (!parsed.success) throw new AdapterError("invalid_output");
          return { status: "completed", value: parsed.data, decision: record(child, dest, route, "completed", permission, ordinal, started, usage) };
        } catch (error) {
          const reason = error === timeout ? "request_timeout" : error instanceof AdapterError ? error.reason : "adapter_failed";
          last = { status: "failed", decision: record(child, dest, route, "failed", reason, ordinal, started, usage) };
          if (reason === "rate_limited") rateLimited = true;
          if (live && config.allowRepair !== false && reason === "invalid_output" && route !== "repair" && !exhausted(child)) {
            route = "repair"; // One clean regeneration, without replaying invalid content.
            continue;
          }
          if (!live || (reason !== "provider_unavailable" && reason !== "request_timeout" && reason !== "capability_unavailable")) return last;
          unavailable.set(dest.model, reason === "request_timeout" ? "provider_unavailable" : reason);
          break;
        }
      }
    }
    return last!;
  }
  return {
    decisions,
    generate: <T>(request: ModelRequest, schema: z.ZodType<T>) => generate(request, schema),
    get budget() { return { used: attempts, limit: limits.maxAttempts }; },
    get stopReason() { return rateLimited ? "rate_limited" as const : exhausted() ? "attempt_budget_exhausted" as const : null; },
    forTask(task: ChildScope["task"], source: Source, maxAttempts: number): TaskGateway {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4) throw new Error("Invalid child budget");
      const child: ChildScope = { task, source, remaining: maxAttempts, decisions: [] };
      return { decisions: child.decisions, generate: (request, schema) => generate(request, schema, child) };
    },
  };
}
