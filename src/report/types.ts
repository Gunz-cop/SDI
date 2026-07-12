export interface Diagnostic {
  code: string;
  message: string;
}

export interface RedactedConfig {
  siteId: string;
  siteUrl: string;
  source: { distDir: string; sitemapPath: string; fallbackToHtmlScan: boolean };
  normalization: { trailingSlash: "preserve" | "always" | "never" };
  statePath: string;
  legacyStatePath?: string;
  reportPath: string;
  indexNow?: { keyEnv: string; keyLocation?: string };
}

export interface ExecutionReport {
  schemaVersion: 1;
  runId: string;
  sdiVersion: string;
  siteId: string;
  mode: "live" | "dry-run" | "baseline";
  status: "success" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  source: { sitemapUsed: boolean; discovered: number; rejected: number; duplicates: number };
  changes: { created: number; updated: number; unchanged: number; deleted: number };
  changeUrls: { created: string[]; updated: string[]; deleted: string[] };
  indexNow?: { submitted: number; batches: number; attempts: number; accepted: boolean };
  warnings: Diagnostic[];
  errors: Diagnostic[];
  config: RedactedConfig;
}
