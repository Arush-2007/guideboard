"use server";

import { excelActionChannel } from "@/inngest/channels/excel-action";
import { mintUserStatusToken } from "@/inngest/channels/mint-status-token";

export async function fetchExcelActionRealtimeToken() {
  return mintUserStatusToken(excelActionChannel);
}
