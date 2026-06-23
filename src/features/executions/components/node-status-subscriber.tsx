"use client";

import { useInngestSubscription } from "@inngest/realtime/hooks";
import { useSetAtom } from "jotai";
import { memo, useEffect } from "react";
import { nodeStatusMapAtom } from "@/features/editor/store/atoms";
import {
  reduceLatestStatuses,
  type StatusMessageLike,
} from "@/features/executions/lib/node-status";
import { refreshTokenByChannel } from "@/features/executions/lib/node-status-registry";

/**
 * Subscribes to ONE realtime channel and merges incoming { nodeId, status }
 * messages into the shared nodeStatusMapAtom. The editor mounts one of these
 * per distinct channel present on the canvas — replacing the old per-node
 * subscription fan-out (which opened one stream per node, several duplicate).
 *
 * Memoized on `channel` and keyed by the channel string at the call site, so
 * adding/dragging nodes never tears down or reconnects an existing channel.
 */
export const NodeStatusSubscriber = memo(({ channel }: { channel: string }) => {
  const setStatusMap = useSetAtom(nodeStatusMapAtom);
  const refreshToken = refreshTokenByChannel[channel];

  const { freshData } = useInngestSubscription({
    refreshToken,
    enabled: Boolean(refreshToken),
    // Batch bursts (a run flipping many nodes at once) into one map write
    // every 100ms instead of one render per message.
    bufferInterval: 100,
  });

  useEffect(() => {
    if (!freshData || freshData.length === 0) return;
    const delta = reduceLatestStatuses(freshData as StatusMessageLike[]);
    if (Object.keys(delta).length === 0) return;
    // Merge, never replace: nodes absent from this batch keep their status.
    setStatusMap((prev) => ({ ...prev, ...delta }));
  }, [freshData, setStatusMap]);

  return null;
});

NodeStatusSubscriber.displayName = "NodeStatusSubscriber";
