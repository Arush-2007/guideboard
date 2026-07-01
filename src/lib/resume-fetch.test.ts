import { describe, expect, it } from "vitest";
import { isDriveSource, normalizeResumeUrl } from "./resume-fetch";

const FILE_ID = "1T_ZGII-67IQMZNMUqPmHTse7w3pc_gqx";
const MEDIA = `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`;

describe("normalizeResumeUrl", () => {
  it("rewrites a Drive /file/d/ share link to a media URL", () => {
    expect(
      normalizeResumeUrl(`https://drive.google.com/file/d/${FILE_ID}/view`),
    ).toBe(MEDIA);
  });

  it("rewrites a Drive open?id= link to a media URL", () => {
    expect(
      normalizeResumeUrl(`https://drive.google.com/open?id=${FILE_ID}`),
    ).toBe(MEDIA);
  });

  it("unwraps a Google Forms upload array of a bare file ID", () => {
    expect(normalizeResumeUrl(`["${FILE_ID}"]`)).toBe(MEDIA);
  });

  it("rewrites a bare Drive file ID", () => {
    expect(normalizeResumeUrl(FILE_ID)).toBe(MEDIA);
  });

  it("passes a plain http(s) URL through untouched", () => {
    const url = "https://example.com/resume.pdf";
    expect(normalizeResumeUrl(url)).toBe(url);
  });

  it("unwraps an array that already holds a full URL", () => {
    const url = "https://example.com/resume.pdf";
    expect(normalizeResumeUrl(`["${url}"]`)).toBe(url);
  });
});

describe("isDriveSource", () => {
  it("is true for Drive URLs, bare IDs, and upload arrays", () => {
    expect(
      isDriveSource(`https://drive.google.com/file/d/${FILE_ID}/view`),
    ).toBe(true);
    expect(isDriveSource(FILE_ID)).toBe(true);
    expect(isDriveSource(`["${FILE_ID}"]`)).toBe(true);
  });

  it("is false for a plain external URL", () => {
    expect(isDriveSource("https://example.com/resume.pdf")).toBe(false);
  });
});
