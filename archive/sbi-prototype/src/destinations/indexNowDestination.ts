import type { DestinationAdapter, SubmissionResult, UrlState } from "../core/types.js";

export class IndexNowDestination implements DestinationAdapter {
  readonly name = "indexnow";
  private readonly host: string;
  private readonly key: string;
  private readonly keyLocation: string;

  constructor(options: { host: string; key: string; keyLocation?: string }) {
    this.host = options.host;
    this.key = options.key;
    this.keyLocation = options.keyLocation ?? `https://${options.host}/${options.key}.txt`;
  }

  async submit(urls: UrlState[]): Promise<SubmissionResult> {
    try {
      const response = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          host: this.host,
          key: this.key,
          keyLocation: this.keyLocation,
          urlList: urls.map((url) => url.url),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          submittedCount: 0,
          errors: urls.map((url) => ({
            url: url.url,
            error: `${response.statusText}: ${errorText}`,
          })),
        };
      }

      return {
        success: true,
        submittedCount: urls.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown IndexNow error";
      return {
        success: false,
        submittedCount: 0,
        errors: urls.map((url) => ({
          url: url.url,
          error: message,
        })),
      };
    }
  }
}
