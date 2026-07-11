import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import type { DestinationAdapter, SubmissionResult, UrlState } from "../core/types.js";

export interface GoogleCredentials {
  clientEmail: string;
  privateKey: string;
}

export class GoogleIndexingDestination implements DestinationAdapter {
  readonly name = "google";
  private readonly credentials: GoogleCredentials;

  constructor(credentials: GoogleCredentials) {
    this.credentials = {
      clientEmail: credentials.clientEmail,
      privateKey: credentials.privateKey.replace(/\\n/g, "\n"),
    };
  }

  async submit(urls: UrlState[]): Promise<SubmissionResult> {
    try {
      const accessToken = await getAccessToken(this.credentials);
      const errors: Array<{ url: string; error: string }> = [];
      let submittedCount = 0;

      for (const item of urls) {
        try {
          const response = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              url: item.url,
              type: "URL_UPDATED",
            }),
          });

          if (!response.ok) {
            errors.push({
              url: item.url,
              error: `${response.statusText}: ${await response.text()}`,
            });
            continue;
          }

          submittedCount += 1;
        } catch (error) {
          errors.push({
            url: item.url,
            error: error instanceof Error ? error.message : "Unknown Google submission error",
          });
        }
      }

      return {
        success: errors.length === 0,
        submittedCount,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Google authentication error";
      return {
        success: false,
        submittedCount: 0,
        errors: urls.map((url) => ({
          url: url.url,
          error: `Authentication failed: ${message}`,
        })),
      };
    }
  }
}

export async function loadGoogleCredentials(options: {
  clientEmail?: string;
  privateKey?: string;
  serviceAccountJson?: string;
  serviceAccountFile?: string;
}): Promise<GoogleCredentials | null> {
  if (options.clientEmail && options.privateKey) {
    return {
      clientEmail: options.clientEmail,
      privateKey: options.privateKey,
    };
  }

  if (options.serviceAccountJson) {
    const parsed = JSON.parse(options.serviceAccountJson) as {
      client_email?: string;
      private_key?: string;
    };
    if (parsed.client_email && parsed.private_key) {
      return {
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
      };
    }
  }

  if (!options.serviceAccountFile) {
    return null;
  }

  try {
    const content = await fs.readFile(options.serviceAccountFile, "utf-8");
    const parsed = JSON.parse(content) as {
      client_email?: string;
      private_key?: string;
    };

    if (!parsed.client_email || !parsed.private_key) {
      return null;
    }

    return {
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getAccessToken(credentials: GoogleCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64urlEncode(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: "https://www.googleapis.com/auth/indexing",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    }),
  );

  const signatureInput = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signatureInput);
  const signature = base64urlEncode(signer.sign(credentials.privateKey));
  const jwt = `${signatureInput}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    throw new Error(`${response.statusText}: ${await response.text()}`);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("Google token response missing access_token");
  }

  return data.access_token;
}

function base64urlEncode(value: string | Buffer): string {
  const buffer = typeof value === "string" ? Buffer.from(value) : value;
  return buffer
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
