import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StateStore, UrlState } from "../core/types.js";

export class FileStateStore implements StateStore {
  private readonly filePath: string;
  private cache: Record<string, UrlState> = {};
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(key: string): Promise<UrlState | null> {
    await this.load();
    return this.cache[key] ?? null;
  }

  async set(key: string, state: UrlState): Promise<void> {
    await this.load();
    this.cache[key] = state;
    await this.save();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    if (!this.cache[key]) {
      return;
    }

    delete this.cache[key];
    await this.save();
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      this.cache = JSON.parse(content) as Record<string, UrlState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.cache = {};
    }

    this.loaded = true;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), "utf-8");
  }
}
