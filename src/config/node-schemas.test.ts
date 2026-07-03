import { describe, expect, it } from "vitest";
import { NodeType } from "@/generated/prisma";
import { parseNodeConfig } from "./node-schemas";

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
