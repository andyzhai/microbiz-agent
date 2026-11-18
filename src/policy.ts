import { isFixture } from "./fixtures.js";
import { isInstruction } from "./profiles.js";
import type { Instruction } from "./profiles.js";
import { isTrustedExchange } from "./tools.js";
import type { Exchange } from "./tools.js";

export type Classification = "synthetic" | "public" | "internal" | "sensitive" | "unknown";
export interface Source { readonly id: string; readonly classification: Classification; readonly content: string }
export interface ModelRequest {
  readonly instruction: Instruction;
  readonly sources: readonly Source[];
  readonly exchange?: Exchange;
}
export interface Destination { readonly model: string; readonly location: "offline" | "local" | "external"; readonly endpoint: string }
export const OFFLINE_DESTINATION: Destination = Object.freeze({ model: "fake-v1", location: "offline", endpoint: "memory:fake-v1" });
export const OPENROUTER = "https://openrouter.ai/api/v1";
export const roles = Object.freeze({
  LOCAL_MODEL: process.env.LOCAL_MODEL ?? "nvidia/nemotron-3.5-super-vl:free",
  CLOUD_MODEL: process.env.CLOUD_MODEL ?? "dots-studio/dots-3-note-preview:free",
});
export function validModelRoles(config: typeof roles): boolean {
  const freeModelId = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/;
  return config.LOCAL_MODEL !== config.CLOUD_MODEL && Object.values(config).every(id => freeModelId.test(id));
}
export type PolicyReason = "allowed_offline_fixture" | "allowed_external_fixture" | "destination_denied" | "source_denied";

export function authorize(request: ModelRequest, dest: Destination): PolicyReason {
  const offline = dest.location === "offline" && dest.endpoint === OFFLINE_DESTINATION.endpoint && dest.model === OFFLINE_DESTINATION.model;
  const external = dest.location === "external" && dest.endpoint === OPENROUTER + "/chat/completions" &&
    validModelRoles(roles) && Object.values<string>(roles).includes(dest.model);
  if (!offline && !external) return "destination_denied";
  if (!isInstruction(request.instruction) || !request.sources.length ||
      request.sources.some(source => !isFixture(source) || source.classification !== "synthetic") ||
      (request.exchange !== undefined && (request.sources.length !== 1 || !isTrustedExchange(request.exchange, request.sources[0]!))))
    return "source_denied";
  return offline ? "allowed_offline_fixture" : "allowed_external_fixture";
}
