import { describe, expect, it } from "vitest";
import {
  asFormat,
  CONVERSIONS,
  canConvert,
  detectFormatFromHint,
  FORMAT_META,
  type Format,
  inputKindForSelection,
  legacyConversionToPair,
  resolveConversion,
  SOURCE_FORMATS,
  sourcesForTarget,
  TARGET_FORMATS,
} from "./conversions";
import { getTextConverter } from "./converters";

describe("capability matrix integrity", () => {
  it("every conversion references known formats", () => {
    for (const c of CONVERSIONS) {
      expect(FORMAT_META[c.from], `from=${c.from}`).toBeDefined();
      expect(FORMAT_META[c.to], `to=${c.to}`).toBeDefined();
    }
  });

  it("has no duplicate (from,to) pairs", () => {
    const keys = CONVERSIONS.map((c) => `${c.from}:${c.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("TARGET_FORMATS is exactly the deduped set of targets", () => {
    expect([...TARGET_FORMATS].sort()).toEqual(
      [...new Set(CONVERSIONS.map((c) => c.to))].sort(),
    );
  });

  it("SOURCE_FORMATS is exactly the deduped set of sources", () => {
    expect([...SOURCE_FORMATS].sort()).toEqual(
      [...new Set(CONVERSIONS.map((c) => c.from))].sort(),
    );
  });

  it("every target is reachable from at least one source", () => {
    for (const to of TARGET_FORMATS) {
      expect(sourcesForTarget(to).length).toBeGreaterThan(0);
    }
  });
});

// Drift guards: the matrix is the single source of truth, so each declared
// engine must have its handler wired. These fail loudly if a pair is added to
// CONVERSIONS without registering its implementation.
describe("engine <-> handler wiring", () => {
  it("every text-sync pair resolves to a converter in converters.ts", () => {
    for (const c of CONVERSIONS) {
      if (c.engine === "text-sync") {
        expect(
          getTextConverter(c.from, c.to),
          `missing converter for ${c.from} -> ${c.to}`,
        ).toBeTypeOf("function");
      }
    }
  });

  it("does not register converters for non-text-sync pairs", () => {
    for (const c of CONVERSIONS) {
      if (c.engine !== "text-sync") {
        expect(getTextConverter(c.from, c.to)).toBeUndefined();
      }
    }
  });
});

describe("resolveConversion / canConvert", () => {
  it("resolves a supported pair to its descriptor", () => {
    expect(resolveConversion("csv", "json")?.engine).toBe("text-sync");
    expect(resolveConversion("pdf", "text")?.engine).toBe("text-fetch");
  });

  it("returns undefined / false for an unsupported pair", () => {
    expect(resolveConversion("text", "json")).toBeUndefined();
    expect(canConvert("json", "text")).toBe(false);
    expect(canConvert("csv", "json")).toBe(true);
  });
});

describe("binary conversions (Phase 3)", () => {
  it("registers image <-> image pairs as binary", () => {
    expect(resolveConversion("png", "jpg")?.engine).toBe("binary");
    expect(resolveConversion("jpg", "webp")?.engine).toBe("binary");
    expect(resolveConversion("webp", "png")?.engine).toBe("binary");
  });

  it("registers image <-> pdf both directions", () => {
    expect(canConvert("png", "pdf")).toBe(true);
    expect(canConvert("pdf", "jpg")).toBe(true);
  });

  it("registers video container swaps and audio extraction", () => {
    expect(resolveConversion("mp4", "mov")?.engine).toBe("binary");
    expect(resolveConversion("mov", "mp4")?.engine).toBe("binary");
    expect(resolveConversion("mp4", "mp3")?.engine).toBe("binary");
    expect(resolveConversion("mov", "mp3")?.engine).toBe("binary");
  });

  it("never maps a format to itself", () => {
    for (const c of CONVERSIONS) expect(c.from).not.toBe(c.to);
  });

  it("exposes the new formats as selectable targets", () => {
    for (const f of [
      "jpg",
      "png",
      "webp",
      "pdf",
      "mp4",
      "mov",
      "mp3",
    ] as const) {
      expect(TARGET_FORMATS).toContain(f);
    }
  });
});

describe("asFormat", () => {
  it("narrows known formats and rejects the rest", () => {
    expect(asFormat("json")).toBe("json");
    expect(asFormat("nope")).toBeUndefined();
    expect(asFormat(undefined)).toBeUndefined();
    expect(asFormat(null)).toBeUndefined();
  });
});

describe("legacyConversionToPair", () => {
  it("maps the pre-restructure enum values", () => {
    expect(legacyConversionToPair("pdf_to_text")).toEqual({
      from: "pdf",
      to: "text",
    });
    expect(legacyConversionToPair("csv_to_json")).toEqual({
      from: "csv",
      to: "json",
    });
  });

  it("returns undefined for unknown / missing values", () => {
    expect(legacyConversionToPair("mystery")).toBeUndefined();
    expect(legacyConversionToPair(undefined)).toBeUndefined();
  });
});

describe("inputKindForSelection", () => {
  it("uses a URL input for binary sources", () => {
    expect(inputKindForSelection("text", "pdf")).toBe("url");
  });

  it("uses a text area for text sources", () => {
    expect(inputKindForSelection("json", "csv")).toBe("text");
  });

  it("defaults by the target's source set when auto-detecting", () => {
    // json's only source is csv (text) -> textarea.
    expect(inputKindForSelection("json")).toBe("text");
  });
});

describe("detectFormatFromHint", () => {
  const cases: Array<[string, Format | undefined]> = [
    ["", undefined],
    ["   ", undefined],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube_url"],
    ["https://www.youtube.com/watch?v=abc", "youtube_url"],
    ["https://www.instagram.com/reel/xyz/", "instagram_url"],
    ["https://example.com/report.pdf", "pdf"],
    ["https://example.com/photo.JPG", "jpg"],
    ["https://example.com/clip.mp4?t=1", "mp4"],
    ["https://example.com/data.csv", "csv"],
    ["https://example.com/some/endpoint", "pdf"], // unknown ext URL -> document
    ['[{"a":1}]', "json"],
    ['{"a":1}', "json"],
    ["<p>Hello <b>world</b></p>", "html"],
    ["# Title\n\nSome **bold** text", "markdown"],
    ["name,email\nAda,ada@x.com", "csv"],
    ["just a sentence", "text"],
  ];

  for (const [input, expected] of cases) {
    it(`detects ${JSON.stringify(input).slice(0, 32)} as ${expected}`, () => {
      expect(detectFormatFromHint(input)).toBe(expected);
    });
  }

  it("treats a bare Google Drive file id as a document", () => {
    expect(detectFormatFromHint("1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUvWx")).toBe(
      "pdf",
    );
  });
});
