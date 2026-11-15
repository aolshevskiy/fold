/**
 * Wording rule for everything in this file: describe units of WORK, never units of
 * conversation. Text that presupposes turn-ending replies ("after the reply",
 * "between tasks") tells a single-turn staged agent that a reply is the natural next
 * move, and it rides in the tool surface of every request. It is the top unproven
 * suspect for the iteration-2 phase flips, and saying the true thing instead costs
 * nothing: the next model call that reads a result, a natural boundary in the work.
 */

type ToolHandler = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: any,
) => Promise<unknown>;

type CommandHandler = (args: string, ctx: any) => Promise<void> | void;

export function buildActiveContextTool(input: {
  name: string;
  label: string;
  allowedActions: readonly string[];
  fullSurface: boolean;
  maxBriefChars: number;
  statusDetails: readonly string[];
  minPeekSliceBytes: number;
  defaultPeekBytes: number;
  handler: ToolHandler;
}) {
  // THE SURFACE IS A TABLE, NOT AN ESSAY (2026-11-16). It was 7.6KB of prose across seven
  // paragraphs, and a model could quote a sentence of it and still pick the wrong verb: on
  // 2026-11-15 an agent spent four status calls and six failed peeks before calling expand,
  // which then applied 41 folds. Five rows, one call each, and then only the distinctions a
  // table flattens. Nothing here restates a schema field — the schema already enforces
  // those, and a prose copy drifts.
  const has = (action: string): boolean => input.allowedActions.includes(action);
  const rows: string[] = [];
  if (has("status")) {
    rows.push("What is staged, and the ids to brief: status {\"action\":\"status\",\"detail\":\"marks\"} " +
      "— each row states the mark's span, its size and a head of its brief.");
  }
  if (has("peek")) {
    rows.push("What something holds: peek {\"action\":\"peek\",\"id\":\"<fold-id>\"} — a staged mark answers " +
      "with its brief, because its bytes are still raw in your window; a standing fold answers with its source.");
  }
  if (has("brief")) {
    rows.push("Write a clause: brief {\"action\":\"brief\",\"briefs\":[{\"id\":\"<fold-id>\",\"brief\":\"…\"}]} " +
      "— free, because a staged mark is not in your window yet, and several in one call.");
  }
  if (has("reboundary")) {
    rows.push("Change a boundary: reboundary {\"action\":\"reboundary\",\"ids\":[\"<start>\",\"<end>\"]} re-cuts " +
      "the span into exactly one fold; with a single id it returns that fold's span to raw.");
  }
  if (has("unmark")) {
    rows.push("Reject a cut: unmark withdraws a staged fold so its span stays raw.");
  }
  if (has("expand")) {
    rows.push("Put bytes back: expand {\"action\":\"expand\",\"id\":\"<fold-id>\"} restores a span in place, and " +
      "refold reverses it. Expanding costs the window; nothing else here does.");
  }
  if (has("status")) {
    rows.push("What is folded, and how much room it costs: status {\"action\":\"status\",\"detail\":\"folds\"}, " +
      "paged by offset and limit.");
    rows.push("Why the runtime acted: status {\"action\":\"status\",\"detail\":\"diagnostics\"}.");
  }
  const intentTable = rows.length ? ` What you want, and the one call for it:\n- ${rows.join("\n- ")}` : "";
  // THE DISTINCTIONS A TABLE FLATTENS, and the only prose that survives it.
  const pinGuidance = has("pin")
    ? " Pin with ids holds folds or entries against automatic folding, consolidation and refolding, and " +
      "unpin releases them. Pinning holds a span and frees nothing toward the commit, so it delays one " +
      "rather than paying for it."
    : "";
  const rebirthGuidance = has("brief")
    ? " A standing fold's brief is not rewritten, because rewriting it rewrites the projection from that " +
      "placeholder on and costs the prefix cache from there."
    : "";
  const recoveryGuidance = has("expand")
    ? " A fold brief is an index entry, not the source: when a question or task depends on material that " +
      "is folded, peek or expand that fold and answer from the exact bytes, never from memory of them."
    : "";
  const standingGuidance = " Folding is automatic, lossless and recoverable: the runtime folds stale " +
    "spans when the window needs room, nothing is ever discarded, and no fold is ever announced in " +
    "advance.";
  const closing = " Mutations persist immediately and affect the next model call inside the same " +
    `continuing turn. Supplied fold briefs have a hard ${input.maxBriefChars}-character maximum.`;
  return {
    name: input.name,
    label: input.label,
    description: input.fullSurface
      ? `Page, peek, brief, expand, refold, pin, or re-cut exact Pi active-context evidence.${intentTable}${pinGuidance}${rebirthGuidance}${recoveryGuidance}${standingGuidance}${closing}`
      : `Use only the configured active-context actions: ${input.allowedActions.join(", ")}.${intentTable}${pinGuidance}${rebirthGuidance}${recoveryGuidance}${standingGuidance}${closing}`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: input.allowedActions },
        ids: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
        id: { type: "string", minLength: 1 },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: input.maxBriefChars,
          description: "Brief only: what you will want back from this pending fold that " +
            "its automatic brief cannot know. Your sentence is kept BESIDE the automatic " +
            `brief, never instead of it, at most ${input.maxBriefChars} characters. Free ` +
            "to write, because the fold it names is not in your window yet.",
        },
        briefs: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "Brief only: several clauses in ONE call, as [{id, brief}, ...]. " +
            "Use this for a sweep: the pending set moves while you write, so one id at a " +
            "time cannot finish it. Every id is answered separately — a stale or unknown " +
            "id is refused by name and never aborts the rest.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "brief"],
            properties: {
              id: { type: "string", minLength: 1 },
              brief: { type: "string", minLength: 1, maxLength: input.maxBriefChars },
            },
          },
        },
        offset: { type: "integer", minimum: 0 },
        ephemeral: {
          type: "boolean",
          description: "Peek only. Default TRUE: the returned bytes ride your context " +
            "exactly until your next message, then their place holds a one-line " +
            "placeholder and your reply is the surviving trace, so extract what you need " +
            "into that reply. Peeking again is lossless. Pass false to keep the result " +
            "standing like any other tool result, which is what you want when the bytes " +
            "have to survive several turns of work.",
        },
        bytes: {
          type: "integer",
          minimum: input.minPeekSliceBytes,
          description: `Peek only: bytes of the plain-text history view to return, widening or narrowing the ${input.defaultPeekBytes}-byte default.`,
        },
        briefOnly: {
          type: "boolean",
          description: "Deprecated, accepted for one release: a plain peek now answers for a " +
            "pending fold as well, returning its brief with source null. Kept so existing " +
            "calls keep working; prefer peek with just an id.",
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        detail: { type: "string", enum: [...input.statusDetails] },
      },
    },
    execute: input.handler,
  };
}

export function buildActiveContextCommands(input: {
  statusName: string;
  foldName: string;
  editorName: string;
  statusHandler: CommandHandler;
  foldHandler: CommandHandler;
  editorHandler: CommandHandler;
}) {
  return [
    {
      name: input.statusName,
      description: "Show active-context fold roots and paging state",
      handler: input.statusHandler,
    },
    {
      name: input.foldName,
      description: "Commit every staged fold in one epoch; with explicit ids, folds exactly that span now; " +
        "works without a main-model request",
      handler: input.foldHandler,
    },
    {
      name: input.editorName,
      description: "Open the context window editor: occupancy, fold roots and briefs, staged marks, pins",
      handler: input.editorHandler,
    },
  ];
}
