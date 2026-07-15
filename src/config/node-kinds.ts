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
