/** A published URL and the fingerprint of its compiled HTML. */
export interface UrlRecord {
  url: string;
  hash: string;
  lastmod?: string;
}

/** A URL found by a source before normalization and fingerprinting. */
export interface DiscoveredResource {
  url: string;
  filePath: string;
  lastmod?: string;
}

export interface DiscoveryState {
  schemaVersion: 1;
  siteId: string;
  siteUrl: string;
  trailingSlash: TrailingSlashPolicy;
  fingerprintProfile: "sha256-raw-html-v1";
  updatedAt: string;
  resources: Record<string, UrlRecord>;
}

export type TrailingSlashPolicy = "preserve" | "always" | "never";

export interface ChangeSet {
  created: UrlRecord[];
  updated: Array<{ before: UrlRecord; after: UrlRecord }>;
  unchanged: UrlRecord[];
  deleted: UrlRecord[];
}

/** Internal seam implemented by the static-build source in the next stage. */
export interface Source {
  discover(): Promise<DiscoveredResource[]>;
}

/** Internal seam implemented by SDI's versioned JSON state store in the next stage. */
export interface StateStore {
  load(): Promise<DiscoveryState | null>;
  save(next: DiscoveryState): Promise<void>;
}

/** Internal seam implemented by IndexNow in the destination stage. */
export interface Destination {
  publish(changes: ChangeSet): Promise<PublishResult>;
}

export interface PublishResult {
  accepted: boolean;
  submittedUrls: number;
  batches: Array<{
    size: number;
    status: number;
    attempts: number;
  }>;
}
