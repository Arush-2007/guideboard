import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import {
  buildPickerSources,
  filterPickerSources,
  getUpstreamFields,
  getUpstreamNodeIds,
  matchFieldByName,
  type PickerSource,
} from "./upstream-fields";

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

describe("getUpstreamFields run order", () => {
  // The picker's first panel lists these node-by-node, so the order is now read
  // directly by the user — it must follow the flow, not the cuid.
  const nodeIdsOf = (rows: { nodeId: string }[]) => [
    ...new Set(rows.map((r) => r.nodeId)),
  ];

  it("orders upstream nodes trigger-first, ignoring id sort order", () => {
    // Ids are deliberately in the REVERSE of run order, so an id sort would
    // produce ["a", "m", "z"] and only run order gives trigger → middle → last.
    const chain = [
      { id: "z", type: NodeType.TELEGRAM_TRIGGER },
      { id: "m", type: NodeType.HTTP_REQUEST },
      { id: "a", type: NodeType.AI_TEXT },
      { id: "end", type: NodeType.DISCORD },
    ];
    const chainEdges = [
      { source: "z", target: "m" },
      { source: "m", target: "a" },
      { source: "a", target: "end" },
    ];

    expect(nodeIdsOf(getUpstreamFields("end", chain, chainEdges))).toEqual([
      "z",
      "m",
      "a",
    ]);
  });

  it("keeps a branch's own nodes ahead of the node they feed (diamond)", () => {
    //      t
    //    /   \
    //   b1    b2
    //    \   /
    //     join  -> end
    const diamond = [
      { id: "t", type: NodeType.TELEGRAM_TRIGGER },
      { id: "b1", type: NodeType.HTTP_REQUEST },
      { id: "b2", type: NodeType.AI_TEXT },
      { id: "join", type: NodeType.SLACK },
      { id: "end", type: NodeType.DISCORD },
    ];
    const diamondEdges = [
      { source: "t", target: "b1" },
      { source: "t", target: "b2" },
      { source: "b1", target: "join" },
      { source: "b2", target: "join" },
      { source: "join", target: "end" },
    ];

    const order = nodeIdsOf(getUpstreamFields("end", diamond, diamondEdges));
    expect(order[0]).toBe("t");
    expect(order.at(-1)).toBe("join");
    expect(order).toHaveLength(4);
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("join"));
    expect(order.indexOf("b2")).toBeLessThan(order.indexOf("join"));
  });

  it("falls back to a stable id order on a cyclic graph instead of throwing", () => {
    // The canvas rejects cycles, but the picker must never be the thing that
    // breaks if one ever reaches it (a hand-rolled save, a future feature).
    const cyclic = [
      { id: "z", type: NodeType.HTTP_REQUEST },
      { id: "a", type: NodeType.AI_TEXT },
      { id: "end", type: NodeType.DISCORD },
    ];
    const cyclicEdges = [
      { source: "z", target: "a" },
      { source: "a", target: "z" },
      { source: "a", target: "end" },
    ];

    expect(nodeIdsOf(getUpstreamFields("end", cyclic, cyclicEdges))).toEqual([
      "a",
      "z",
    ]);
  });
});

describe("matchFieldByName", () => {
  // Auto-map takes the first match out of a run-ordered list, so the trigger is
  // always the first candidate. Without an exact-match pass, its verbose labels
  // win on position alone — deterministically, for every graph shaped this way.
  const fields = [
    { fieldLabel: "Sender first name", insertText: "@<telegram.from.first>@" },
    { fieldLabel: "Name", insertText: "@<AI_TEXT_1.name>@" },
  ];

  it("prefers an exact match over an earlier substring match", () => {
    expect(matchFieldByName("Name", fields)?.insertText).toBe(
      "@<AI_TEXT_1.name>@",
    );
  });

  it("matches on letters and digits only, ignoring case and punctuation", () => {
    expect(matchFieldByName("  name!  ", fields)?.insertText).toBe(
      "@<AI_TEXT_1.name>@",
    );
    expect(
      matchFieldByName("Phone_Number", [
        { fieldLabel: "phone number", insertText: "@<t.phone>@" },
      ])?.insertText,
    ).toBe("@<t.phone>@");
  });

  it("falls back to a substring match, earliest first, when none is exact", () => {
    expect(matchFieldByName("First", fields)?.insertText).toBe(
      "@<telegram.from.first>@",
    );
  });

  it("matches a target that contains a field's label, not just the reverse", () => {
    expect(
      matchFieldByName("Candidate email address", [
        { fieldLabel: "Email", insertText: "@<t.email>@" },
      ])?.insertText,
    ).toBe("@<t.email>@");
  });

  it("returns undefined when nothing matches", () => {
    expect(matchFieldByName("Invoice total", fields)).toBeUndefined();
  });
});

describe("filterPickerSources", () => {
  const field = (path: string) => ({
    fieldLabel: path,
    path,
    insertText: `@<${path}>@`,
  });
  const source = (key: string, label: string, paths: string[]) =>
    ({
      key,
      label,
      kind: "fields",
      fields: paths.map(field),
    }) as PickerSource;

  const sources: PickerSource[] = [
    source("a", "OG_Sheets", ["OG_Sheets.Job No", "OG_Sheets.tsc"]),
    source("b", "OG_Trigger", ["OG_Trigger.output"]),
    source("c", "Backlog_Sync", ["Backlog_Sync.output"]),
  ];
  const labelsOf = (result: PickerSource[]) => result.map((s) => s.label);

  it("returns everything for an empty query", () => {
    expect(filterPickerSources(sources, "")).toBe(sources);
  });

  it("narrows to the nodes a prefix can still become", () => {
    expect(labelsOf(filterPickerSources(sources, "OG"))).toEqual([
      "OG_Sheets",
      "OG_Trigger",
    ]);
  });

  it("is prefix-only, so a middle-of-the-name match is not kept", () => {
    // The query is the start of what will be INSERTED, so `Backlog_Sync`
    // containing "og" does not qualify. Substring matching here would keep it on
    // screen and prevent the narrowing to one that lets the panel drill in.
    expect(filterPickerSources(sources, "log")).toEqual([]);
  });

  it("narrows to exactly one, which is what triggers the drill-in", () => {
    expect(labelsOf(filterPickerSources(sources, "OG_S"))).toEqual([
      "OG_Sheets",
    ]);
  });

  it("ignores case and separators", () => {
    expect(labelsOf(filterPickerSources(sources, "ogs"))).toEqual([
      "OG_Sheets",
    ]);
    expect(labelsOf(filterPickerSources(sources, "og_sheets"))).toEqual([
      "OG_Sheets",
    ]);
  });

  it("narrows the surviving node's FIELDS by the part after the dot", () => {
    const [only] = filterPickerSources(sources, "og_sheets.j");
    expect(
      only.kind === "fields" && only.fields.map((f) => f.insertText),
    ).toEqual(["@<OG_Sheets.Job No>@"]);
  });

  it("reaches a path containing a space without the space being typed", () => {
    // `sanitizeHeaderKey` strips only dots, so a header keeps its spaces
    // (`Job No`) — but the QUERY may not contain one (see NOT_IN_PATH), so this
    // is the only way such a field can be narrowed to. Matching normalizes
    // separators away, which is what makes it reachable.
    const [only] = filterPickerSources(sources, "og_sheets.jobn");
    expect(
      only.kind === "fields" && only.fields.map((f) => f.insertText),
    ).toEqual(["@<OG_Sheets.Job No>@"]);
  });

  it("matches a root-level trigger field that has no node segment", () => {
    // `commentId` IS its own root — one rule covers it because the query is
    // matched against the whole path rather than split at the dot.
    const topLevel = [source("t", "Instagram Comment Trigger", ["commentId"])];
    expect(labelsOf(filterPickerSources(topLevel, "comm"))).toEqual([
      "Instagram Comment Trigger",
    ]);
  });

  it("keeps the custom group only while the query can still spell it", () => {
    const custom = [{ key: "custom", label: "X - Custom", kind: "custom" }];
    expect(filterPickerSources(custom as PickerSource[], "cus")).toHaveLength(
      1,
    );
    expect(filterPickerSources(custom as PickerSource[], "og")).toEqual([]);
  });
});

describe("buildPickerSources", () => {
  const labelForType = (type: string) =>
    ({
      [NodeType.TELEGRAM_TRIGGER]: "Telegram Trigger",
      [NodeType.AI_TEXT]: "AI Text",
      [NodeType.GOOGLE_SHEETS_ACTION]: "Google Sheets",
    })[type];

  const currentNode = {
    type: NodeType.GOOGLE_SHEETS_ACTION,
    data: { ref: "GOOGLE_SHEETS_ACTION_1" },
  };

  const rows = [
    {
      nodeId: "t1",
      nodeType: NodeType.TELEGRAM_TRIGGER,
      nodeRef: null,
      fieldLabel: "Sender first name",
      path: "telegram.from.firstName",
      insertText: "@<telegram.from.firstName>@",
    },
    {
      nodeId: "a1",
      nodeType: NodeType.AI_TEXT,
      nodeRef: "AI_TEXT_1",
      fieldLabel: "AI output",
      path: "AI_TEXT_1.output",
      insertText: "@<AI_TEXT_1.output>@",
    },
    {
      nodeId: "a1",
      nodeType: NodeType.AI_TEXT,
      nodeRef: "AI_TEXT_1",
      fieldLabel: "Model",
      path: "AI_TEXT_1.model",
      insertText: "@<AI_TEXT_1.model>@",
    },
  ];

  it("groups fields per node, preserving the run order rows arrive in", () => {
    const sources = buildPickerSources({ rows, currentNode, labelForType });

    expect(sources.map((s) => s.key)).toEqual(["node:t1", "node:a1"]);
    expect(sources[1]).toMatchObject({
      kind: "fields",
      label: "AI_TEXT_1",
      // A renamed node's type is the subtitle; the ref alone doesn't say it.
      sublabel: "AI Text",
    });
    expect(
      sources[1].kind === "fields"
        ? sources[1].fields.map((f) => f.fieldLabel)
        : [],
    ).toEqual(["AI output", "Model"]);
  });

  it("does not repeat a trigger's type label as its own subtitle", () => {
    const [trigger] = buildPickerSources({ rows, currentNode, labelForType });
    expect(trigger.label).toBe("Telegram Trigger");
    expect(trigger.sublabel).toBeUndefined();
  });

  it("names the current node's own sources after it, ahead of the nodes", () => {
    const sources = buildPickerSources({
      rows,
      currentNode,
      hasCustomFeatures: true,
      extraGroups: [
        {
          label: "Row above",
          fields: [
            {
              fieldLabel: "Name",
              path: "anchorRow.Name",
              insertText: "@<anchorRow.Name>@",
            },
          ],
        },
      ],
      labelForType,
    });

    expect(sources.map((s) => s.label)).toEqual([
      "GOOGLE_SHEETS_ACTION_1 - Custom",
      "GOOGLE_SHEETS_ACTION_1 - Row above",
      "Telegram Trigger",
      "AI_TEXT_1",
    ]);
    // Both wear the current node's icon, so they read as belonging to this step.
    expect(sources[0].nodeType).toBe(NodeType.GOOGLE_SHEETS_ACTION);
    expect(sources[1].nodeType).toBe(NodeType.GOOGLE_SHEETS_ACTION);
    expect(sources[0].kind).toBe("custom");
  });

  it("names an unrenamed trigger's own sources by its type label", () => {
    const sources = buildPickerSources({
      rows: [],
      currentNode: { type: NodeType.TELEGRAM_TRIGGER, data: {} },
      hasCustomFeatures: true,
      labelForType,
    });
    expect(sources.map((s) => s.label)).toEqual(["Telegram Trigger - Custom"]);
  });

  it("omits the custom row when the node offers no custom features", () => {
    const sources = buildPickerSources({
      rows,
      currentNode,
      hasCustomFeatures: false,
      labelForType,
    });
    expect(sources.some((s) => s.kind === "custom")).toBe(false);
  });
});

describe("getUpstreamFields ref handling", () => {
  // The canvas carries a node's ref at `data.ref` (React Flow only passes `data`
  // to a node, and the editor's history preserves nothing else) — so the picker
  // must read it from there, not from a top-level field.
  const refNodes = [
    { id: "t1", type: NodeType.TELEGRAM_TRIGGER, data: {} },
    { id: "h1", type: NodeType.HTTP_REQUEST, data: { ref: "HTTP_REQUEST_1" } },
    { id: "c1", type: NodeType.DISCORD, data: { ref: "DISCORD_1" } },
  ];

  it("heads the group with the ref from data and keys paths by it", () => {
    const rows = getUpstreamFields("c1", refNodes, edges);
    const fromHttp = rows.filter((r) => r.nodeId === "h1");

    expect(fromHttp.length).toBeGreaterThan(0);
    // The name the picker heads its panel with, and the inserted token, are the
    // SAME string the canvas shows.
    expect(fromHttp.every((r) => r.nodeRef === "HTTP_REQUEST_1")).toBe(true);
    expect(
      fromHttp.every((r) => r.insertText.startsWith("@<HTTP_REQUEST_1.")),
    ).toBe(true);
    // The legacy <type>_<id> key must not survive once a ref exists.
    expect(rows.some((r) => r.insertText.includes("http_request_h1"))).toBe(
      false,
    );
  });

  it("carries no ref for a ref-less trigger, leaving it to be named by type", () => {
    const rows = getUpstreamFields("c1", refNodes, edges);
    const fromTrigger = rows.filter((r) => r.nodeId === "t1");

    expect(fromTrigger.length).toBeGreaterThan(0);
    expect(fromTrigger.every((r) => r.nodeRef === null)).toBe(true);
    // With no registry label to reach for, the name falls back to the humanized
    // type — the behaviour the row's bare `nodeRef` hands to `displayNameFor`.
    const [trigger] = buildPickerSources({
      rows: fromTrigger,
      currentNode: refNodes[2],
      labelForType: () => undefined,
    });
    expect(trigger.label).toBe("telegram trigger");
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
    const JOINED_GROUP =
      "Whether the row joined an existing group (true/false)";
    const ROW_NUMBER = "The sheet row number this step wrote";
    const ANCHOR_ROW = "The row the new row was placed under (all columns)";

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
    expect(updateLabels).toContain(ROW_NUMBER);
    expect(updateLabels).not.toContain(ROWS_ADDED);
    expect(updateLabels).not.toContain(ROW_MATCHED);
    expect(updateLabels).not.toContain(JOINED_GROUP);

    // A non-bottom append (position under_*) writes ONE new row, so it shares
    // `rowByHeader` with the other writers and `matchCount` with the other
    // matchers (there the count is the size of the group it joined), and adds
    // `insertedUnderGroup`. It never updates a row, so update's `matched` /
    // `previousRow` are absent, and it is not a bottom append so ROWS_ADDED is
    // absent too.
    const insertLabels = labelsFor({
      action: "append_row",
      position: "under_group",
    });
    expect(insertLabels).toContain(ROW_WRITTEN);
    expect(insertLabels).toContain(MATCH_COUNT);
    expect(insertLabels).toContain(JOINED_GROUP);
    expect(insertLabels).toContain(ROW_NUMBER);
    expect(insertLabels).toContain(ANCHOR_ROW);
    expect(insertLabels).not.toContain(WAS_FOUND);
    expect(insertLabels).not.toContain(ROW_BEFORE);
    expect(insertLabels).not.toContain(ROWS_ADDED);
    expect(insertLabels).not.toContain(ROW_MATCHED);

    // A node saved before the insert_row_adjacent → append_row merge keeps the
    // old action until re-saved. The picker reads that raw config, so it must
    // normalize it and offer the SAME fields as a modern under-append (not the
    // bottom-append counter).
    const legacyInsertLabels = labelsFor({
      action: "insert_row_adjacent",
      insertUnder: "group",
    });
    expect(legacyInsertLabels).toContain(ROW_WRITTEN);
    expect(legacyInsertLabels).toContain(MATCH_COUNT);
    expect(legacyInsertLabels).toContain(JOINED_GROUP);
    expect(legacyInsertLabels).toContain(ANCHOR_ROW);
    expect(legacyInsertLabels).not.toContain(ROWS_ADDED);
  });
});
