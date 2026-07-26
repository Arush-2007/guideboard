import { describe, expect, it } from "vitest";
import { copyBaseName, nextCopyName } from "./workflow-copy";

describe("copyBaseName", () => {
  it("strips a copy suffix", () => {
    expect(copyBaseName("Lead capture.2")).toBe("Lead capture");
    expect(copyBaseName("Lead capture.17")).toBe("Lead capture");
  });

  it("leaves a name with no suffix alone", () => {
    expect(copyBaseName("Lead capture")).toBe("Lead capture");
    expect(copyBaseName("Lead capture 2")).toBe("Lead capture 2");
  });

  it("leaves .0 and .1 alone — they are never minted as suffixes", () => {
    expect(copyBaseName("Sheet 2.0")).toBe("Sheet 2.0");
    expect(copyBaseName("Release.1")).toBe("Release.1");
  });
});

describe("nextCopyName", () => {
  it("numbers the first copy .2", () => {
    expect(nextCopyName("Lead capture", ["Lead capture"])).toBe(
      "Lead capture.2",
    );
  });

  it("counts up as copies accumulate", () => {
    expect(
      nextCopyName("Lead capture", ["Lead capture", "Lead capture.2"]),
    ).toBe("Lead capture.3");
    expect(
      nextCopyName("Lead capture", [
        "Lead capture",
        "Lead capture.2",
        "Lead capture.3",
      ]),
    ).toBe("Lead capture.4");
  });

  it("copies a copy into the same series, not a nested one", () => {
    expect(
      nextCopyName("Lead capture.2", ["Lead capture", "Lead capture.2"]),
    ).toBe("Lead capture.3");
  });

  it("does not refill a gap left by a deleted copy", () => {
    expect(
      nextCopyName("Lead capture", ["Lead capture", "Lead capture.3"]),
    ).toBe("Lead capture.4");
  });

  it("ignores names that only share a prefix", () => {
    expect(
      nextCopyName("Lead capture", [
        "Lead capture",
        "Lead capture v2.5",
        "Lead capture extra.2",
        "Lead capture.two",
      ]),
    ).toBe("Lead capture.2");
  });

  it("treats a name that is only a prefix of others as its own series", () => {
    // "Lead" must not be numbered off "Lead capture.4".
    expect(nextCopyName("Lead", ["Lead", "Lead capture.4"])).toBe("Lead.2");
  });
});
