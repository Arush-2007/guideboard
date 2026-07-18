import { z } from "zod";

/**
 * The single source for the three matching-option zod fields (`CompareOptions`
 * in `compare.ts`). Spread into EVERY schema that validates a comparison —
 * the server config schemas (`node-schemas.ts`) and each editor dialog's own
 * form schema alike.
 *
 * This exists because a plain `z.object()` STRIPS undeclared keys on parse: a
 * dialog whose condition schema omits these fields silently drops the options
 * on submit, so they never reach `node.data` (they save as "off" and the
 * comparison stays strict). Keeping one fragment means a dialog and the server
 * can't drift — add a fourth option here and every schema gets it.
 *
 * Kept in its own tiny, zod-only module (not in the pure `compare.ts`) so the
 * comparator stays dependency-free for the hot execution path.
 */
export const compareOptionsSchemaFields = {
  ignoreCase: z.boolean().optional(),
  ignoreChars: z.string().optional(),
  numeric: z.boolean().optional(),
};
