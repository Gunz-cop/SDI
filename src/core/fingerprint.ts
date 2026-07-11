import { createHash } from "node:crypto";

export const FINGERPRINT_PROFILE = "sha256-raw-html-v1";

/** Returns the SHA-256 hex digest of the exact compiled HTML bytes. */
export function fingerprintHtml(html: Uint8Array): string {
  return createHash("sha256").update(html).digest("hex");
}
