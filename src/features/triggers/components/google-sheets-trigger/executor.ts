import { NonRetriableError } from "inngest";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "@/config/node-schemas";
import type { NodeExecutor } from "@/features/executions/types";
import { googleSheetsTriggerChannel } from "@/inngest/channels/google-sheets-trigger";

type GoogleSheetsTriggerData = {
  spreadsheetId?: string;
  sheetName?: string;
};

export const googleSheetsTriggerExecutor: NodeExecutor<GoogleSheetsTriggerData> =
  async ({ nodeId, context, step, publish, data }) => {
    await publish(
      googleSheetsTriggerChannel().status({
        nodeId,
        status: "loading",
      }),
    );

    try {
      parseNodeConfig(NodeType.GOOGLE_SHEETS_TRIGGER, data);
    } catch (error) {
      await publish(
        googleSheetsTriggerChannel().status({
          nodeId,
          status: "error",
        }),
      );
      throw new NonRetriableError(
        error instanceof Error ? error.message : "Invalid node config",
      );
    }

    const result = await step.run("google-sheets-trigger", async () => context);

    await publish(
      googleSheetsTriggerChannel().status({
        nodeId,
        status: "success",
      }),
    );

    return result;
  };
