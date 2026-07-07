import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { getNodeConfigIssues, parseNodeConfig } from "./node-schemas";

describe("node config schema registry", () => {
  // Guards the architecture's invariant: every NodeType must have a schema
  // registered so parseNodeConfig never hits its "no schema" throw at runtime.
  it("has a schema registered for every NodeType", () => {
    for (const type of Object.values(NodeType)) {
      expect(() => parseNodeConfig(type, {})).not.toThrow(
        /No node config schema registered/,
      );
    }
  });

  it("accepts a valid http request config", () => {
    expect(() =>
      parseNodeConfig(NodeType.HTTP_REQUEST, {
        endpoint: "https://example.com",
        method: "GET",
      }),
    ).not.toThrow();
  });

  it("rejects an http request config with an invalid method", () => {
    expect(() =>
      parseNodeConfig(NodeType.HTTP_REQUEST, {
        endpoint: "https://example.com",
        method: "FETCH",
      }),
    ).toThrow(/Invalid node.data/);
  });

  it("rejects a discord config missing its webhook url", () => {
    expect(() => parseNodeConfig(NodeType.DISCORD, { content: "hi" })).toThrow(
      /Invalid node.data/,
    );
  });

  it("accepts a convert config with a fixed target (source auto-detected)", () => {
    expect(() =>
      parseNodeConfig(NodeType.CONVERT, { to: "json", input: "a,b\n1,2" }),
    ).not.toThrow();
  });

  it("accepts a legacy convert config (single `conversion` enum)", () => {
    expect(() =>
      parseNodeConfig(NodeType.CONVERT, {
        conversion: "csv_to_json",
        input: "a,b\n1,2",
      }),
    ).not.toThrow();
  });

  it("rejects a convert config with neither a target nor a legacy conversion", () => {
    expect(() =>
      parseNodeConfig(NodeType.CONVERT, { input: "a,b\n1,2" }),
    ).toThrow(/target format is required/i);
  });

  it("rejects a convert config with an unknown target format", () => {
    expect(() =>
      parseNodeConfig(NodeType.CONVERT, { to: "not-a-format", input: "x" }),
    ).toThrow(/Invalid node.data/);
  });
});

describe("getNodeConfigIssues", () => {
  // The editor's pre-run validation depends on this never throwing for any
  // NodeType (a throw would break the canvas), always returning an array.
  it("returns an array for every NodeType without throwing", () => {
    for (const type of Object.values(NodeType)) {
      const issues = getNodeConfigIssues(type, {});
      expect(Array.isArray(issues)).toBe(true);
    }
  });

  it("reports issues for an empty required config", () => {
    // Discord requires content + a webhook url; empty data must surface issues.
    expect(getNodeConfigIssues(NodeType.DISCORD, {}).length).toBeGreaterThan(0);
    expect(
      getNodeConfigIssues(NodeType.HTTP_REQUEST, {}).length,
    ).toBeGreaterThan(0);
  });

  it("returns an empty array for a fully valid config", () => {
    expect(
      getNodeConfigIssues(NodeType.DISCORD, {
        content: "hi",
        webhookUrl: "https://discord.com/api/webhooks/x",
      }),
    ).toEqual([]);
    expect(
      getNodeConfigIssues(NodeType.HTTP_REQUEST, {
        endpoint: "https://example.com",
        method: "GET",
      }),
    ).toEqual([]);
  });

  it("treats an empty-passthrough node (manual trigger) as always valid", () => {
    expect(getNodeConfigIssues(NodeType.MANUAL_TRIGGER, {})).toEqual([]);
  });

  it("flags an unconfigured Typeform trigger (needs credential + form)", () => {
    expect(
      getNodeConfigIssues(NodeType.TYPEFORM_TRIGGER, {}).length,
    ).toBeGreaterThan(0);
    expect(
      getNodeConfigIssues(NodeType.TYPEFORM_TRIGGER, {
        credentialId: "cred_1",
        formId: "form_1",
      }),
    ).toEqual([]);
  });

  it("flags an unconfigured Google Form trigger (needs a form)", () => {
    expect(
      getNodeConfigIssues(NodeType.GOOGLE_FORM_TRIGGER, {}).length,
    ).toBeGreaterThan(0);
    expect(
      getNodeConfigIssues(NodeType.GOOGLE_FORM_TRIGGER, { formId: "form_1" }),
    ).toEqual([]);
  });

  it("leaves comment triggers valid when empty (optional post/video by design)", () => {
    // The dialogs explicitly allow an empty filter ("all posts"/"all videos"),
    // so an unconfigured comment trigger must NOT be flagged.
    expect(getNodeConfigIssues(NodeType.INSTAGRAM_COMMENT_TRIGGER, {})).toEqual(
      [],
    );
    expect(getNodeConfigIssues(NodeType.YOUTUBE_COMMENT_TRIGGER, {})).toEqual(
      [],
    );
  });
});
