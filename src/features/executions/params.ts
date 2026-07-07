import { parseAsInteger, parseAsString, parseAsStringEnum } from "nuqs/server";
import { PAGINATION } from "@/config/constants";
import { ExecutionStatus } from "@/generated/prisma";

export const executionsParams = {
  page: parseAsInteger
    .withDefault(PAGINATION.DEFAULT_PAGE)
    .withOptions({ clearOnDefault: true }),
  pageSize: parseAsInteger
    .withDefault(PAGINATION.DEFAULT_PAGE_SIZE)
    .withOptions({ clearOnDefault: true }),
  // Absent = "All". parseAsStringEnum rejects any ?status=… that isn't a real
  // ExecutionStatus, so a junk value falls back to null (no filter) rather than
  // erroring the list.
  status: parseAsStringEnum(Object.values(ExecutionStatus)).withOptions({
    clearOnDefault: true,
  }),
  workflowId: parseAsString
    .withDefault("")
    .withOptions({ clearOnDefault: true }),
};
