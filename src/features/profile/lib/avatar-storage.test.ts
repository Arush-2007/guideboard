import { describe, expect, it } from "vitest";
import {
  avatarObjectKey,
  avatarPublicPath,
  isValidAvatarFile,
  parseAvatarPath,
  sniffAvatarContentType,
} from "./avatar-storage";

const bytesFrom = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string"
        ? Array.from(new TextEncoder().encode(part))
        : part,
    ),
  );

/** Signature + enough padding to clear the 12-byte minimum. */
const pad = (n: number) => new Array(n).fill(0);

describe("sniffAvatarContentType", () => {
  it("identifies PNG", () => {
    const png = bytesFrom(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      pad(8),
    );
    expect(sniffAvatarContentType(png)).toBe("image/png");
  });

  it("identifies JPEG", () => {
    expect(sniffAvatarContentType(bytesFrom([0xff, 0xd8, 0xff], pad(12)))).toBe(
      "image/jpeg",
    );
  });

  it("identifies WebP by both the RIFF container and the WEBP tag", () => {
    expect(sniffAvatarContentType(bytesFrom("RIFF", pad(4), "WEBP"))).toBe(
      "image/webp",
    );
  });

  it("rejects a RIFF container that isn't WebP (e.g. a WAV)", () => {
    expect(
      sniffAvatarContentType(bytesFrom("RIFF", pad(4), "WAVE")),
    ).toBeNull();
  });

  it("rejects payloads that only claim to be images", () => {
    expect(sniffAvatarContentType(bytesFrom("<svg xmlns=..."))).toBeNull();
    expect(sniffAvatarContentType(bytesFrom("<!DOCTYPE html>"))).toBeNull();
  });

  it("rejects a body too short to carry a signature", () => {
    expect(sniffAvatarContentType(bytesFrom([0x89, 0x50]))).toBeNull();
  });
});

describe("isValidAvatarFile", () => {
  it("accepts the filenames this app writes", () => {
    expect(isValidAvatarFile("clh3k2m9x0000abcd1234.webp")).toBe(true);
    expect(isValidAvatarFile("abcd1234.jpg")).toBe(true);
  });

  it.each([
    ["a traversal attempt", "../../secrets.webp"],
    ["a nested path", "nested/file.webp"],
    ["an unexpected extension", "abcd1234.svg"],
    ["no extension", "abcd1234"],
    ["too short to be a cuid", "abc.webp"],
    ["uppercase, which we never emit", "ABCD1234.webp"],
  ])("rejects %s", (_name, file) => {
    expect(isValidAvatarFile(file)).toBe(false);
  });
});

describe("key + path helpers", () => {
  it("round-trips a stored avatar path back to its parts", () => {
    const path = avatarPublicPath("user_1", "abcd1234.webp");
    expect(path).toBe("/api/profile/avatar/user_1/abcd1234.webp");
    expect(parseAvatarPath(path)).toEqual({
      userId: "user_1",
      file: "abcd1234.webp",
    });
    expect(avatarObjectKey("user_1", "abcd1234.webp")).toBe(
      "avatars/user_1/abcd1234.webp",
    );
  });

  it.each([
    ["an external OAuth avatar", "https://lh3.googleusercontent.com/a/xyz"],
    ["an unset image", null],
    ["an empty image", ""],
    ["a lookalike path with a traversal", "/api/profile/avatar/u1/..%2Fx.webp"],
    ["some other app route", "/api/profile/avatar"],
  ])("returns null for %s", (_name, image) => {
    expect(parseAvatarPath(image)).toBeNull();
  });
});
