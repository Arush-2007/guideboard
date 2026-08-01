import { NodeType } from "@/generated/prisma";

/**
 * The node types that are TRIGGERS — the entry points of a workflow.
 *
 * This is the single source of truth for "is this node type a trigger?", and it
 * is load-bearing in two very different places:
 *
 *  - **Client**: draw-time connection validation rejects edges pointing into a
 *    trigger, and the canvas warns about nodes that aren't wired into the flow.
 *  - **Server**: the Inngest engine runs *only* triggers as roots — every other
 *    node must be reached by a live edge or it is recorded SKIPPED (see the
 *    reachability gate in `src/inngest/run-workflow.ts`).
 *
 * It lives in its own module, separate from `node-options.ts`, precisely so the
 * engine can import it: `node-options.ts` carries the user-facing label/icon
 * metadata and therefore pulls in `lucide-react` and the integrations registry,
 * which must never reach the server bundle. **Keep this file import-pure** — the
 * Prisma enum and nothing else.
 *
 * `node-options.ts` re-exports this as `triggerNodeTypeSet`, and
 * `node-kinds.test.ts` asserts the selectable trigger list and the Prisma enum
 * both stay in lockstep with it — so adding a trigger to `NodeType` without
 * listing it here fails the build rather than silently making that trigger a
 * non-root that never runs.
 */
export const TRIGGER_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  NodeType.MANUAL_TRIGGER,
  NodeType.GOOGLE_FORM_TRIGGER,
  NodeType.TYPEFORM_TRIGGER,
  NodeType.GMAIL_TRIGGER,
  NodeType.GOOGLE_SHEETS_TRIGGER,
  NodeType.SCHEDULE_TRIGGER,
  NodeType.WEBHOOK_TRIGGER,
  NodeType.INSTAGRAM_COMMENT_TRIGGER,
  NodeType.YOUTUBE_COMMENT_TRIGGER,
  NodeType.TELEGRAM_TRIGGER,
]);

/** Whether `type` is a trigger (the only node kind the engine runs as a root). */
export const isTriggerNodeType = (type: string | null | undefined): boolean =>
  Boolean(type) && TRIGGER_NODE_TYPES.has(type as NodeType);

/**
 * Whether a node type must get its OWN Inngest step, or may run inline inside a
 * shared one.
 *
 * The engine batches contiguous runs of inline-safe nodes into a single
 * `step.run` (see `runWorkflowNodes`), because Inngest Cloud charges ~4 seconds
 * of dispatch latency per step — the entire cost of a workflow run, dwarfing the
 * work itself. Fewer steps, proportionally faster runs.
 *
 * The price is retry granularity. Inngest memoizes completed steps, so today a
 * transient failure re-runs only the failed node. Inside a batched segment a
 * retry re-runs **every node in that segment**. `true` here means "re-running
 * this node is not safe", and it buys back per-node retry isolation.
 *
 * ⚠️ **This map is the entire safety argument for batching.** It is a total
 * `Record`, so a new `NodeType` fails to compile until it is classified — but
 * nothing can check that a VALUE is right. Marking a node `false` when
 * re-running it duplicates an email, a payment or a spreadsheet row is a silent
 * data-corruption bug that only appears under retry. When unsure, `true`: the
 * cost of a wrong `true` is four seconds, the cost of a wrong `false` is a
 * duplicate side effect.
 *
 * The four questions that decide it — answered by READING the executor, never by
 * the node's name:
 *
 *  1. **Does it mutate anything outside this process?** Sends a message, writes
 *     a row, creates a record → `true`. Eight of the senders below already say
 *     so themselves, via `idempotent: false` in their own `rethrowTimeout` call.
 *  2. **Does it cost money per call?** LLM tokens, a CloudConvert job, a paid
 *     parse or a paid SCORE → `true`. A replay is billed again.
 *  3. **Does it split a READ from a WRITE across two `step.run`s?** If so the
 *     split is load-bearing and inlining destroys it — the memoized plan is what
 *     makes the write replay-safe. See `GOOGLE_SHEETS_ACTION` below.
 *  4. **Can it make an unbounded third-party call?** → `true`, even when
 *     repeating it is perfectly safe. This one is about TIME, not correctness: a
 *     whole segment shares ONE step, so it must fit inside one
 *     `MAX_STEP_BUDGET_MS`. A single `HTTP_TIMEOUT.READ` is 30s and `SLOW_API`
 *     is 45s, so two such nodes in a segment can blow the step budget between
 *     them. Every `false` below therefore also makes no unbounded call —
 *     `MAX_SEGMENT_NODES` derives its cap from that being true.
 *
 * Questions 3 and 4 are the subtle ones, and both were missed on the first pass.
 * 3 is invisible unless you read the executor. 4 looks like a performance
 * concern right up until a segment exceeds the platform ceiling and the run dies
 * as an opaque kill rather than a node failure.
 */
export const CHECKPOINTED_NODE_TYPES: Record<NodeType, boolean> = {
  // ─── Inline-safe: triggers ────────────────────────────────────────────────
  // Every trigger is a passthrough. The inbound webhook / poller / cron has
  // already seeded its payload into `initialData`; the executor validates config
  // and returns `context` untouched. Nothing to repeat.
  [NodeType.MANUAL_TRIGGER]: false,
  [NodeType.WEBHOOK_TRIGGER]: false,
  [NodeType.SCHEDULE_TRIGGER]: false,
  [NodeType.GMAIL_TRIGGER]: false,
  [NodeType.GOOGLE_SHEETS_TRIGGER]: false,
  [NodeType.GOOGLE_FORM_TRIGGER]: false,
  [NodeType.TYPEFORM_TRIGGER]: false,
  [NodeType.TELEGRAM_TRIGGER]: false,
  [NodeType.INSTAGRAM_COMMENT_TRIGGER]: false,
  [NodeType.YOUTUBE_COMMENT_TRIGGER]: false,
  // A canvas placeholder that runs the manual-trigger passthrough.
  [NodeType.INITIAL]: false,

  // ─── Inline-safe: pure computation ────────────────────────────────────────
  // No third-party call, no side effect — all four declare their failures
  // `NonRetriableError` for exactly that reason. `CODE` runs user JS in a
  // QuickJS-WASM sandbox with no I/O BY CONSTRUCTION rather than by policy: the
  // input crosses in as a JSON literal and the result comes back as a string,
  // with no host function ever bridged into the isolate (`js-sandbox.ts`).
  //
  // Two footnotes that do not change the classification but should not be lost.
  // `CODE` is not strictly DETERMINISTIC — QuickJS still provides `Date.now()`
  // and `Math.random()`. That stays contained because a segment only re-runs
  // when its own step failed, i.e. before anything downstream consumed its
  // output. And `CODE` is the only one of the four that is not instant: it
  // carries a hard 1s interrupt deadline, which is what bounds
  // `MAX_SEGMENT_NODES`.
  [NodeType.CONDITION]: false,
  [NodeType.SWITCH]: false,
  [NodeType.CALCULATOR]: false,
  [NodeType.CODE]: false,

  // ─── Checkpointed: safe to repeat, but too SLOW to share a step ───────────
  // Both pass questions 1-3 and fail question 4. They are why question 4 exists.
  //
  // RECORD_LOOKUP genuinely is a read — the Notion `/query` POST carries its
  // filter in a body and mutates nothing, and the Sheets path is `readSheetTable`.
  // But it is a NETWORK read: `HTTP_TIMEOUT.READ` is 30s and the Google path adds
  // a 10s token refresh in front of it, so one node can occupy 40s of a 60s step
  // budget and two cannot coexist in a segment at all.
  //
  // (That token refresh also does a `prisma.googleCredential.update` and can
  // persist a rotated refresh token, so "pure read" is not literally true either.
  // It is expiry-gated and user-invisible, so it never drove this — but the
  // comment should not claim more than the code does.)
  [NodeType.RECORD_LOOKUP]: true,
  // CANDIDATE_SCORING's `rules` provider really is a pure scorecard, but its
  // `affinda` provider is BILLED: `/v3/resume_search/match` is Affinda's paid
  // Search & Match, on the same credential as RESUME_PARSER, which is
  // checkpointed for precisely that reason. Question 2 applies and was missed —
  // an earlier version of this file argued only that re-running is harmless
  // (it is: `ensureResumeIndexed` treats "already exists" as success on every
  // path) and never asked what a replay COSTS. Two nodes, one paid vendor, and
  // the classification has to match.
  //
  // It was also the slowest inline candidate there was: `SLOW_API` 45s to index
  // plus `SLOW_API` 45s to match is 90s in ONE node — more than the entire step
  // budget — so a segment containing it could be killed by the platform before
  // any other node in that segment had run.
  [NodeType.CANDIDATE_SCORING]: true,

  // ─── Checkpointed: sends a message a second send would duplicate ──────────
  // All eight declare `idempotent: false` in their own `rethrowTimeout` config,
  // with the same note: "A retry would send/post/create ... a SECOND time."
  [NodeType.GMAIL_ACTION]: true,
  [NodeType.SLACK]: true,
  [NodeType.DISCORD]: true,
  [NodeType.NOTION_ACTION]: true,
  [NodeType.TELEGRAM_ACTION]: true,
  [NodeType.WHATSAPP_ACTION]: true,
  [NodeType.INSTAGRAM_REPLY_COMMENT]: true,
  [NodeType.YOUTUBE_REPLY_COMMENT]: true,

  // ─── Checkpointed: creates an external record ─────────────────────────────
  // Creates a Lever opportunity, then adds a note in a second step so a note
  // retry can't re-create the candidate. Both halves are `idempotent: false`.
  [NodeType.ATS_ACTION]: true,

  // ─── Checkpointed: read/write split that must stay memoized ───────────────
  // The reason this one is NOT the safe read it looks like. Every write path
  // splits a plan step from a write step, and the split is what makes the write
  // replay-safe:
  //   • append_row  — the row number comes from `nextFreeSheetRow`. Replay the
  //     plan after the write landed and it points one row lower: a DUPLICATE row.
  //     The `under_*` variants replay a structural `insertDimension`, shifting
  //     every row below a second time.
  //   • update_row  — the filter usually tests a column the update writes. On
  //     replay the updated row no longer matches, so either nothing matches (the
  //     run reports `matched: false` and takes the No-match branch despite having
  //     succeeded) or, worse, "first" now resolves to a DIFFERENT row and writes
  //     to one the user never selected.
  //   • style_cells — `mergeCells` keeps only the top-left cell, so a replayed
  //     read re-matches nothing and routes No-match after styling succeeded.
  // `find_rows` and a non-merging `style_cells` genuinely ARE safe, but this map
  // is keyed by type and one type covers all four actions, so the whole node is
  // checkpointed. Splitting it per-action is a tracked follow-up.
  [NodeType.GOOGLE_SHEETS_ACTION]: true,
  // Same read/plan/write shape against Microsoft Graph.
  [NodeType.EXCEL_ACTION]: true,

  // ─── Checkpointed: billed per call ────────────────────────────────────────
  // Five LLM nodes. A replay is a second inference and a second bill. They are
  // also the only executors that use `step.ai.wrap` rather than `step.run`.
  [NodeType.AI_TEXT]: true,
  [NodeType.OPENAI]: true,
  [NodeType.ANTHROPIC]: true,
  [NodeType.GEMINI]: true,
  [NodeType.AI_REPLY_GENERATOR]: true,
  // The binary engine creates a PAID CloudConvert job and writes to R2; its
  // two-step split exists so a retry of the expensive half reuses the same job
  // instead of buying another. The text engines are pure, but see the per-action
  // note on Sheets above — same reason, same follow-up.
  [NodeType.CONVERT]: true,
  // The `affinda` provider is a billed parse. The `builtin` provider is a plain
  // download-and-extract; same per-config follow-up.
  [NodeType.RESUME_PARSER]: true,

  // ─── Checkpointed: safe only for some configurations ──────────────────────
  // Calls an arbitrary third-party API. A GET is safe to repeat and the executor
  // already computes `isSafeMethod` for its timeout classification — but a
  // POST/PUT/PATCH/DELETE may already have landed, and this map cannot see the
  // method. Fail closed; the per-config follow-up covers it.
  [NodeType.HTTP_REQUEST]: true,
};

/**
 * Whether this node type needs its own Inngest step rather than sharing a
 * batched one. Unknown types fail CLOSED — a type absent from the map (only
 * reachable via a non-`NodeType` string) is treated as unsafe to repeat.
 */
export const requiresCheckpoint = (type: NodeType): boolean =>
  CHECKPOINTED_NODE_TYPES[type] ?? true;
