import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { getUpstreamFields, getUpstreamNodeIds } from "./upstream-fields";

const nodes = [
  { id: "t1", type: NodeType.TELEGRAM_TRIGGER },
  { id: "h1", type: NodeType.HTTP_REQUEST },
  { id: "c1", type: NodeType.DISCORD },
];
// t1 -> h1 -> c1
const edges = [
  { source: "t1", target: "h1" },
  { source: "h1", target: "c1" },
];

describe("getUpstreamNodeIds", () => {
  it("returns transitive upstream nodes, excluding the node itself", () => {
    expect([...getUpstreamNodeIds("c1", edges)].sort()).toEqual(["h1", "t1"]);
    expect([...getUpstreamNodeIds("h1", edges)]).toEqual(["t1"]);
    expect([...getUpstreamNodeIds("t1", edges)]).toEqual([]);
  });
});

describe("getUpstreamFields", () => {
  it("expands a declared trigger into field-level @<path>@ entries", () => {
    const rows = getUpstreamFields("c1", nodes, edges);

    const firstName = rows.find(
      (r) => r.insertText === "@<telegram.from.firstName>@",
    );
    expect(firstName).toBeDefined();
    expect(firstName?.fieldLabel).toBe("Sender first name");
    expect(firstName?.nodeId).toBe("t1");

    // The fixed-root trigger must NOT be keyed as telegram_trigger_t1.
    expect(rows.some((r) => r.insertText.includes("telegram_trigger"))).toBe(
      false,
    );
    // Contact phone is exposed (needed for the "name + number" use case).
    expect(
      rows.some((r) => r.insertText === "@<telegram.contact.phoneNumber>@"),
    ).toBe(true);
  });

  it("falls back to a whole-output blob for undeclared node types", () => {
    // MANUAL_TRIGGER has no fixed output shape and is intentionally undeclared.
    const undeclaredNodes = [
      { id: "x1", type: NodeType.MANUAL_TRIGGER },
      { id: "c1", type: NodeType.DISCORD },
    ];
    const undeclaredEdges = [{ source: "x1", target: "c1" }];
    const rows = getUpstreamFields("c1", undeclaredNodes, undeclaredEdges);
    const manual = rows.find((r) => r.nodeId === "x1");
    expect(manual).toBeDefined();
    expect(manual?.fieldLabel).toBe("Whole output");
    expect(manual?.insertText).toBe("@<manual_trigger_x1>@");
  });

  it("expands a declared action (HTTP request) into nested field paths", () => {
    const rows = getUpstreamFields("c1", nodes, edges);
    const status = rows.find(
      (r) => r.insertText === "@<http_request_h1.httpResponse.status>@",
    );
    expect(status).toBeDefined();
    expect(status?.fieldLabel).toBe("Status code");
  });

  it("excludes downstream and self fields", () => {
    // From h1, only t1 is upstream — discord (c1) is downstream, so no rows.
    const rows = getUpstreamFields("h1", nodes, edges);
    expect(rows.every((r) => r.nodeId === "t1")).toBe(true);
  });

  it("expands a declared perNode node (AI) keyed by its node id", () => {
    const aiNodes = [
      { id: "a1", type: NodeType.AI_TEXT },
      { id: "c2", type: NodeType.DISCORD },
    ];
    const aiEdges = [{ source: "a1", target: "c2" }];
    const rows = getUpstreamFields("c2", aiNodes, aiEdges);
    expect(rows).toContainEqual(
      expect.objectContaining({
        insertText: "@<ai_text_a1.output>@",
        fieldLabel: "AI output",
      }),
    );
  });

  it("filters config-dependent fields by the node's saved data (pickIf)", () => {
    const edges2 = [{ source: "g1", target: "c2" }];
    const labelsFor = (data: Record<string, unknown>) =>
      getUpstreamFields(
        "c2",
        [
          { id: "g1", type: NodeType.GOOGLE_SHEETS_ACTION, data },
          { id: "c2", type: NodeType.DISCORD },
        ],
        edges2,
      ).map((r) => r.fieldLabel);

    const ROW_WRITTEN = "The row this step wrote (all columns)";
    const ROWS_ADDED = "How many rows were added";
    const ROW_MATCHED = "The row this run matched (all columns)";
    const MATCH_COUNT = "How many rows matched the filter";
    const ROW_BEFORE = "The row as it was BEFORE this step changed it";
    const WAS_FOUND = "Whether a row was found to update (true/false)";

    const findLabels = labelsFor({ action: "find_rows" });
    expect(findLabels).toContain(ROW_MATCHED);
    expect(findLabels).toContain(MATCH_COUNT);
    expect(findLabels).not.toContain(ROWS_ADDED);
    expect(findLabels).not.toContain(WAS_FOUND);

    // append_row is the default when action is unset.
    const appendLabels = labelsFor({});
    expect(appendLabels).toContain(ROW_WRITTEN);
    expect(appendLabels).toContain(ROWS_ADDED);
    expect(appendLabels).not.toContain(ROW_MATCHED);
    expect(appendLabels).not.toContain(MATCH_COUNT);

    // update_row shares `rowByHeader` with append (one entry, so the friendly
    // views can't render it twice) and `matchCount` with find_rows, and adds
    // `matched` + `previousRow` of its own. It must NOT offer append's counter.
    const updateLabels = labelsFor({ action: "update_row" });
    expect(updateLabels).toContain(ROW_WRITTEN);
    expect(updateLabels).toContain(MATCH_COUNT);
    expect(updateLabels).toContain(WAS_FOUND);
    expect(updateLabels).toContain(ROW_BEFORE);
    expect(updateLabels).not.toContain(ROWS_ADDED);
    expect(updateLabels).not.toContain(ROW_MATCHED);
  });
});
