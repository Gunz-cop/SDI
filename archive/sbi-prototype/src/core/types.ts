export interface UrlState {
  url: string;
  hash: string;
  lastmod?: string;
}

export interface StateStore {
  get(key: string): Promise<UrlState | null>;
  set(key: string, state: UrlState): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SubmissionError {
  url: string;
  error: string;
}

export interface SubmissionResult {
  success: boolean;
  submittedCount: number;
  errors?: SubmissionError[];
}

export interface DestinationAdapter {
  name: string;
  submit(urls: UrlState[]): Promise<SubmissionResult>;
}

export interface SubmissionLogEntry {
  url: string;
  published: string;
  submitted: string;
  destinations: string[];
  results: Record<string, { success: boolean; error?: string }>;
}

export interface DiscoveryRunOptions {
  logPath: string;
  dryRun?: boolean;
  forceSubmit?: boolean;
  optionalDestinations?: string[];
}

export interface DiscoveryRunSummary {
  manifestUrls: string[];
  changed: UrlState[];
  deleted: string[];
  logEntries: SubmissionLogEntry[];
  dryRun: boolean;
}
