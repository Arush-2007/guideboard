import { NodeType } from "@/generated/prisma";

/**
 * Registry of node "custom features" — reusable behaviors a node can attach to
 * one of its mapped fields (e.g. force a Sheets column to auto-number). Surfaced
 * as a "Custom" group in the variable picker for the node being configured, and
 * interpreted by that node's executor via the token in `custom-feature-token.ts`.
 *
 * A node may declare any number of features, and the same feature can be shared
 * across node types (add it to more than one entry below).
 */

export type CustomFeatureParam = {
  key: string;
  label: string;
  type: "number";
  default: number;
  min?: number;
};

export type CustomFeature = {
  id: string;
  label: string;
  description?: string;
  /** Inline params configured when the feature is inserted from the picker. */
  params: CustomFeatureParam[];
};

export const SERIAL_NUMBER_FEATURE: CustomFeature = {
  id: "serialNumber",
  label: "Serial Number",
  description:
    "Auto-numbers this column on each new row (highest existing value + 1). Make it the column's only value.",
  params: [
    { key: "start", label: "Start at", type: "number", default: 1, min: 0 },
    { key: "pad", label: "Pad width", type: "number", default: 0, min: 0 },
  ],
};

const nodeCustomFeatures: Partial<Record<NodeType, CustomFeature[]>> = {
  [NodeType.GOOGLE_SHEETS_ACTION]: [SERIAL_NUMBER_FEATURE],
  // Sharing a feature across nodes is a one-line add, e.g.:
  //   [NodeType.EXCEL_ACTION]: [SERIAL_NUMBER_FEATURE],
};

/** Custom features available on a given node type (empty if none). */
export function getCustomFeatures(
  type: NodeType | string | null | undefined,
): CustomFeature[] {
  if (!type) return [];
  return nodeCustomFeatures[type as NodeType] ?? [];
}
