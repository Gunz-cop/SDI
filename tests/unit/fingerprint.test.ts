import { describe, expect, it } from "vitest";
import { FINGERPRINT_PROFILE, fingerprintHtml } from "../../src/core/fingerprint.js";

describe("fingerprintHtml", () => {
  it("hashes the exact compiled HTML bytes with SHA-256", () => {
    expect(fingerprintHtml(Buffer.from("<html>SDI</html>"))).toBe(
      "50d6c280411ba0845ad18595fa732741683ed632f6390a15aa9f293d4b55a33a",
    );
    expect(FINGERPRINT_PROFILE).toBe("sha256-raw-html-v1");
  });

  it("distinguishes different byte sequences", () => {
    expect(fingerprintHtml(Buffer.from("<p>one</p>"))).not.toBe(fingerprintHtml(Buffer.from("<p>one</p>\n")));
  });
});
