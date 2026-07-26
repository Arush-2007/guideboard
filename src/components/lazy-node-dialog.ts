"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

/**
 * Code-splits a node's configuration dialog out of the canvas bundle.
 *
 * The one thing this adds over calling `dynamic()` directly is a Suspense
 * boundary, and it is not optional. `next/dynamic` builds one ONLY when the
 * options say `ssr: false` or supply a `loading` component:
 *
 *     const hasSuspenseBoundary = !opts.ssr || !!opts.loading;
 *
 * Every node passed a bare loader and no options, so every dialog was a raw
 * `React.lazy` with no boundary of its own. Opening one the first time
 * therefore suspended at the nearest ANCESTOR boundary — the route's
 * `<Suspense fallback={<EditorLoading/>}>`, which wraps the header and the
 * whole canvas. React tore the editor down to the skeleton to load a dialog
 * chunk and rebuilt it afterwards, which reset both halves of the canvas:
 * `useState(workflow.nodes)` re-seeded from the query cache, so the graph
 * reverted to its last SAVED state, and React Flow got a fresh store, which
 * seeds `fitViewQueued` from the `fitView` prop and so auto-fit the viewport
 * again. That is the "zoom in, open a node, and the canvas jumps back to where
 * it started" bug — worst on a large workflow, where the zoom is exactly what
 * you needed to reach the node in the first place.
 *
 * `loading: () => null` is what creates the boundary; the null render is also
 * what we want on screen, since a dialog is a modal overlay and a placeholder
 * behind it would just be a flash. `ssr: false` would work too, but it wraps
 * the dialog in `BailoutToCSR` (which throws if it is ever reached during a
 * prerender) to buy nothing here — these dialogs only ever render on a click.
 *
 * Shared rather than repeated as an options object at 35 call sites, because
 * the failure is invisible: a dialog registered without the boundary looks and
 * behaves correctly right up until it is opened on a canvas someone has panned.
 */
export function lazyNodeDialog<P extends object>(
  loader: () => Promise<ComponentType<P>>,
): ComponentType<P> {
  return dynamic(loader, { loading: () => null });
}
