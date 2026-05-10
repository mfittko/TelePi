import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { getHomeDirectory } from "./paths.js";

/**
 * Maximum number of dedupe keys retained per Telegram context.
 * When the limit is reached the oldest keys are dropped.
 */
const MAX_KEYS_PER_CONTEXT = 1000;

/**
 * Write-behind flush delay in milliseconds.
 * Batches rapid updates into a single disk write.
 */
const FLUSH_DELAY_MS = 1000;

type RawStore = Record<string, string[]>;

/**
 * Persisted, bounded dedupe store for session notification IDs.
 *
 * Scoped by Telegram context key (chat/topic). Entries are persisted to a
 * JSON file so that re-delivered notifications are suppressed across bot
 * restarts. A write-behind timer batches rapid updates to avoid excessive
 * I/O.
 */
export class NotificationDedupeStore {
  private readonly inMemory = new Map<string, Set<string>>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;

  constructor(private readonly filePath: string) {}

  /**
   * Create a store backed by the default TelePi config directory.
   */
  static createDefault(): NotificationDedupeStore {
    const filePath = path.join(
      getHomeDirectory(),
      ".config",
      "telepi",
      "notification-dedupe.json",
    );
    return new NotificationDedupeStore(filePath);
  }

  /**
   * Returns true if the entry ID has already been delivered for this context.
   */
  has(contextKey: string, id: string): boolean {
    return this.getSet(contextKey).has(id);
  }

  /**
   * Records an entry ID as delivered for this context.
   * Schedules a background flush to persist the update.
   */
  add(contextKey: string, id: string): void {
    const set = this.getSet(contextKey);
    if (set.has(id)) {
      return;
    }
    set.add(id);
    this.dirty = true;
    this.scheduleFlush();
  }

  /**
   * Flush pending changes to disk synchronously.
   *
   * Reads the existing on-disk store first and merges it with the in-memory
   * state before writing. This preserves dedupe entries for Telegram
   * chat/topic contexts that were not loaded during the current process
   * lifetime, preventing those contexts from receiving duplicate notifications
   * after a bot restart.
   *
   * Call during graceful shutdown to avoid data loss.
   */
  flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;

    // Start from the current on-disk state to preserve contexts not in memory.
    let baseStore: RawStore = {};
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, "utf8");
        const parsed = JSON.parse(raw) as RawStore;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          baseStore = parsed;
        }
      }
    } catch {
      // Corrupted file — start fresh; in-memory state will be written below.
    }

    // Overwrite with in-memory state (which may have newer/more entries).
    const store: RawStore = { ...baseStore };
    for (const [key, ids] of this.inMemory) {
      const arr = [...ids];
      // Trim to the most recent MAX_KEYS_PER_CONTEXT entries.
      store[key] = arr.slice(-MAX_KEYS_PER_CONTEXT);
    }

    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(store), "utf8");
    } catch (error) {
      console.error("Failed to persist notification dedupe state:", error);
    }
  }

  /**
   * Cancel any pending flush and do a final synchronous flush.
   */
  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
  }

  private getSet(contextKey: string): Set<string> {
    if (!this.inMemory.has(contextKey)) {
      this.inMemory.set(contextKey, this.loadFromDisk(contextKey));
    }
    return this.inMemory.get(contextKey)!;
  }

  private loadFromDisk(contextKey: string): Set<string> {
    try {
      if (!existsSync(this.filePath)) {
        return new Set();
      }
      const raw = readFileSync(this.filePath, "utf8");
      const store = JSON.parse(raw) as RawStore;
      const ids = Array.isArray(store[contextKey]) ? store[contextKey] : [];
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
  }
}
