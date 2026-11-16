export type Classification = "synthetic" | "public" | "internal" | "sensitive" | "unknown";

export interface Source {
  readonly id: string;
  readonly classification: Classification;
  readonly content: string;
}

export interface Destination {
  readonly model: string;
  readonly location: "offline" | "local" | "external";
  readonly endpoint: string;
}

export const OFFLINE_DESTINATION: Destination = Object.freeze({
  model: "fake-v1",
  location: "offline",
  endpoint: "memory:fake-v1",
});

export type PolicyReason = "allowed_offline_fixture" | "destination_denied" | "source_denied";

// The application supplies immutable objects from its bundled fixture loader.
// A matching ID or a caller-supplied classification is never proof of provenance.
export function createPolicy(approvedSources: readonly Source[]) {
  const trusted = new WeakSet(approvedSources);
  return (sources: readonly Source[], destination: Destination): PolicyReason => {
    if (
      destination.model !== OFFLINE_DESTINATION.model ||
      destination.location !== OFFLINE_DESTINATION.location ||
      destination.endpoint !== OFFLINE_DESTINATION.endpoint
    ) return "destination_denied";
    if (sources.length === 0 || sources.some(source =>
      !trusted.has(source) || !Object.isFrozen(source) || source.classification !== "synthetic"
    )) return "source_denied";
    return "allowed_offline_fixture";
  };
}

export type Policy = ReturnType<typeof createPolicy>;
