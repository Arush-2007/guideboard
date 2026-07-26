/**
 * The canvas's physical dimensions, in one place.
 *
 * These numbers are load-bearing in two directions at once: the React Flow
 * canvas is configured from them, and the auto-layout reasons about them to
 * decide where nodes can sit without their names colliding. They used to be
 * duplicated — `snapGrid={[10, 10]}` in editor.tsx against a `GRID = 10` in
 * auto-layout.ts, and Tailwind's `size-20` / `max-w-[200px]` against hardcoded
 * copies — where nothing failed at compile or test time when they drifted, but
 * a refined node would silently land off-grid or under an overlapping label.
 */

/**
 * Grid the canvas snaps to (`snapGrid` / `snapToGrid`). Any position the layout
 * produces is rounded to this, so a refined node is already where the user's
 * next drag would put it rather than jumping into alignment on first touch.
 */
export const SNAP_GRID = 10;

/**
 * The node box, matching `size-20` (5rem) on `<BaseNode>` in
 * base-execution-node.tsx and base-trigger-node.tsx.
 *
 * This is what React Flow *measures*, so it is also the box `fitView` computes
 * its bounds from — which is why the aspect-ratio maths uses it rather than the
 * wider label footprint below.
 */
export const NODE_SIZE = 80;

/**
 * Widest a node's name label can render, matching the `maxWidth` applied in
 * workflow-node.tsx.
 *
 * ⚠️ Bigger than the node itself, and invisible to React Flow: the label is a
 * `<NodeToolbar position={Position.Bottom}>`, which portals OUTSIDE the node's
 * measured box. `node.measured.width` therefore reports NODE_SIZE and no
 * layout that trusts measurement can know the name is there. Spacing columns by
 * the measured width is exactly why names used to overlap, so the layout
 * reserves this instead.
 */
export const NODE_LABEL_MAX_WIDTH = 200;
