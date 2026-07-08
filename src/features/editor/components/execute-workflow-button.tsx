import { useReactFlow } from "@xyflow/react";
import { useAtomValue } from "jotai";
import { FlaskConicalIcon } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { nodeOptionByType } from "@/config/node-options";
import type { NodeType } from "@/generated/prisma";
import { useExecuteWorkflow } from "@/features/workflows/hooks/use-workflows";
import { invalidNodeConfigAtom } from "../store/atoms";

export const ExecuteWorkflowButton = ({
  workflowId,
}: {
  workflowId: string;
}) => {
  const executeWorkflow = useExecuteWorkflow();
  const invalidMap = useAtomValue(invalidNodeConfigAtom);
  const { getNodes } = useReactFlow();

  const isInvalid = Object.keys(invalidMap).length > 0;

  // Names of the misconfigured nodes for the tooltip. Keyed on the invalid-map
  // atom value (stable identity until it changes) and the stable `getNodes`, so
  // it recomputes only when the invalid set changes. Falls back to the raw type
  // if a node type has no registered option.
  const invalidNames = useMemo(() => {
    const ids = Object.keys(invalidMap);
    if (ids.length === 0) return [];
    const byId = new Map(getNodes().map((node) => [node.id, node]));
    return ids.map((id) => {
      const type = byId.get(id)?.type as NodeType | undefined;
      return (type && nodeOptionByType[type]?.label) || type || id;
    });
  }, [invalidMap, getNodes]);

  const handleExecute = () => {
    executeWorkflow.mutate({ id: workflowId });
  };

  const button = (
    <Button
      size="lg"
      onClick={handleExecute}
      disabled={executeWorkflow.isPending || isInvalid}
    >
      <FlaskConicalIcon className="size-4" />
      Execute workflow
    </Button>
  );

  if (!isInvalid) return button;

  return (
    <Tooltip>
      {/* A disabled button swallows pointer events, so the tooltip trigger wraps
          it in a span that can receive the hover. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-medium">Finish configuring before running:</p>
        <ul className="mt-1 list-disc pl-4">
          {invalidNames.map((name, i) => (
            // Node names can repeat (two Discord nodes), so index-key the list.
            // biome-ignore lint/suspicious/noArrayIndexKey: labels are not unique
            <li key={i}>{name}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
};
