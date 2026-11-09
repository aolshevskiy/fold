import { evidenceSha256, sha256Value } from "../json.ts";
import { ownValue } from "./canonical.ts";
import { MAX_LEDGER_ENTRIES } from "./policy.ts";

/**
 * Keep the newest entries, drop the rest.
 *
 * THE LEDGER WAS THE LAST UNBOUNDED ARRAY IN THE STATUS PAYLOAD (2026-11-09). Its three
 * arrays grow with session length rather than fold count, and nothing ever pruned them,
 * so a long session both retained and cloned every event it had ever recorded. Dropping
 * the oldest is free of consequence: `emit()` writes each event to the durable stream
 * before it reaches the ledger, so the array is a tail cache of a transcript, not the
 * record. Nothing reads an entry here that is not also on disk.
 *
 * Callers must keep their TOTALS monotonic. `sequence`, `projections` and `countsByKind`
 * are running counters, never recomputed from this list, so a truncation changes what a
 * reader can inspect and never what it is told happened.
 */
function retainNewest<T>(list: T[], entry: T): void {
  list.push(entry);
  if (list.length > MAX_LEDGER_ENTRIES) list.shift();
}

export type ProjectionChange = "identical" | "append" | "rewrite";

export interface ProjectionComparison {
  change: ProjectionChange;
  previousCount: number;
  nextCount: number;
  appendedCount: number;
  firstDivergentIndex: number | null;
}

export function messageDigests(messages: readonly unknown[]): string[] {
  return messages.map((message) => {
    try { return evidenceSha256(message); }
    catch { return sha256Value({ unhashable: true }); }
  });
}

export function compareProjections(
  previous: readonly string[] | null,
  next: readonly string[],
): ProjectionComparison {
  if (!previous) {
    return {
      change: "append",
      previousCount: 0,
      nextCount: next.length,
      appendedCount: next.length,
      firstDivergentIndex: null,
    };
  }
  let firstDivergentIndex: number | null = null;
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous[index] !== next[index]) { firstDivergentIndex = index; break; }
  }
  if (firstDivergentIndex !== null || next.length < previous.length) {
    return {
      change: "rewrite",
      previousCount: previous.length,
      nextCount: next.length,
      appendedCount: Math.max(0, next.length - previous.length),
      firstDivergentIndex: firstDivergentIndex ?? shared,
    };
  }
  return {
    change: next.length === previous.length ? "identical" : "append",
    previousCount: previous.length,
    nextCount: next.length,
    appendedCount: next.length - previous.length,
    firstDivergentIndex: null,
  };
}

export interface ProjectionRecord extends ProjectionComparison {
  ordinal: number;
  prefixSha256: string;
}

export interface CacheObservation {
  ordinal: number;
  change: ProjectionChange;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  providerSideMiss: boolean;
}

export const CONTEXT_EVENT_SCHEMA_VERSION = 1;

export interface ContextEvent {
  v: number;
  seq: number;
  kind: string;
  session_id: string;
  ordinal: number;
  at: number;
  revision: number;
  [field: string]: unknown;
}

export type ContextEventKind =
  | "context.attempt"
  | "context.correction"
  | "context.pin"
  | "context.capacity"
  | "context.receipt"
  | "context.frontier"
  | "context.commit"
  | "context.fold"
  | "context.brief"
  | "context.absorb"
  | "context.recovery"
  | "context.suspend"
  | "context.settings"
  | "context.rollback"
  | "context.projection"
  | "context.usage"
  | "context.prefix"
  | "context.anchor"
  | "context.drift";

export function prefixDivergence(
  previous: string | null,
  next: string,
): { index: number | null; identicalChars: number; identicalShare: number } {
  if (previous === null) return { index: null, identicalChars: 0, identicalShare: 0 };
  const shared = Math.min(previous.length, next.length);
  let index = 0;
  while (index < shared && previous.charCodeAt(index) === next.charCodeAt(index)) index += 1;
  const diverged = index < shared || next.length < previous.length;
  return {
    index: diverged ? index : null,
    identicalChars: index,
    identicalShare: next.length > 0 ? index / next.length : 0,
  };
}

export interface InstrumentationLedger {
  projections: number;
  rewrites: number;
  appends: number;
  identical: number;
  providerSideMisses: number;
  observedMisses: number;
  records: ProjectionRecord[];
  observations: CacheObservation[];
  events: ContextEvent[];
  sequence: number;
  countsByKind: Record<string, number>;
}

export function emptyLedger(): InstrumentationLedger {
  return {
    projections: 0,
    rewrites: 0,
    appends: 0,
    identical: 0,
    providerSideMisses: 0,
    observedMisses: 0,
    records: [],
    observations: [],
    events: [],
    sequence: 0,
    countsByKind: {},
  };
}

export function recordContextEvent(
  ledger: InstrumentationLedger,
  kind: ContextEventKind,
  envelope: { session_id: string; ordinal: number; revision: number; at: number },
  payload: Record<string, unknown> = {},
): ContextEvent {
  ledger.sequence += 1;
  const record: ContextEvent = {
    v: CONTEXT_EVENT_SCHEMA_VERSION,
    seq: ledger.sequence,
    kind,
    session_id: envelope.session_id,
    ordinal: envelope.ordinal,
    at: envelope.at,
    revision: envelope.revision,
    ...payload,
  };
  ledger.countsByKind[kind] = (ledger.countsByKind[kind] ?? 0) + 1;
  retainNewest(ledger.events, record);
  return record;
}

export function recordProjection(
  ledger: InstrumentationLedger,
  comparison: ProjectionComparison,
  digests: readonly string[],
): void {
  ledger.projections += 1;
  if (comparison.change === "rewrite") ledger.rewrites += 1;
  else if (comparison.change === "append") ledger.appends += 1;
  else ledger.identical += 1;
  retainNewest(ledger.records, {
    ...comparison,
    ordinal: ledger.projections,
    prefixSha256: sha256Value(digests.slice(0, comparison.previousCount || digests.length)),
  });
}

export const PROVIDER_SIDE_MISS_PRESERVED_SHARE = 0.99;

export function observeCacheUsage(
  ledger: InstrumentationLedger,
  input: { usage: unknown; change: ProjectionChange; preservedShare?: number | null },
): CacheObservation | null {
  const usage = input.usage;
  const inputTokens = ownValue(usage, "input");
  const cacheReadTokens = ownValue(usage, "cacheRead");
  const rawCacheWriteTokens = ownValue(usage, "cacheWrite");
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0 ||
      typeof cacheReadTokens !== "number" || !Number.isFinite(cacheReadTokens) ||
      cacheReadTokens < 0) return null;
  const cacheWriteTokens = typeof rawCacheWriteTokens === "number" &&
      Number.isFinite(rawCacheWriteTokens) && rawCacheWriteTokens >= 0
    ? rawCacheWriteTokens
    : 0;
  const missed = cacheReadTokens === 0;
  const preserved = typeof input.preservedShare === "number" && Number.isFinite(input.preservedShare)
    ? input.preservedShare
    : null;
  const observation: CacheObservation = {
    ordinal: ledger.projections,
    change: input.change,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    providerSideMiss: missed && cacheWriteTokens === 0 && (input.change !== "rewrite" ||
      (preserved !== null && preserved >= PROVIDER_SIDE_MISS_PRESERVED_SHARE)),
  };
  if (missed) ledger.observedMisses += 1;
  if (observation.providerSideMiss) ledger.providerSideMisses += 1;
  retainNewest(ledger.observations, observation);
  return observation;
}

export function ledgerSummary(ledger: InstrumentationLedger): Record<string, unknown> {
  return {
    projections: ledger.projections,
    projectionRewrites: ledger.rewrites,
    projectionAppends: ledger.appends,
    projectionsUnchanged: ledger.identical,
    observedCacheMisses: ledger.observedMisses,
    providerSideCacheMisses: ledger.providerSideMisses,
    contextEvents: ledger.sequence,
    contextEventsByKind: { ...ledger.countsByKind },
    // A TRUNCATED ARRAY AND A SHORT ONE LOOK IDENTICAL WITHOUT THIS (2026-11-09). The
    // arrays above are totals and the arrays on the diagnostics page are only the newest
    // MAX_LEDGER_ENTRIES, so a reader comparing events.length to contextEvents would read
    // the ring as a bug. Retained is what is inspectable; the counters above are what
    // happened.
    retained: {
      projectionRecords: ledger.records.length,
      cacheObservations: ledger.observations.length,
      events: ledger.events.length,
    },
  };
}
