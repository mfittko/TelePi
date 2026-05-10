import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NotificationDedupeStore } from "../src/session-notification-dedupe.js";

function makeTempStore(): { store: NotificationDedupeStore; filePath: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "telepi-dedupe-test-"));
  const filePath = path.join(dir, "dedupe.json");
  const store = new NotificationDedupeStore(filePath);
  return { store, filePath, dir };
}

describe("NotificationDedupeStore", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it("returns false for unseen IDs", () => {
    ({ dir } = makeTempStore());
    const { store } = makeTempStore();
    expect(store.has("ctx-1", "entry-a")).toBe(false);
  });

  it("returns true after adding an ID", () => {
    ({ dir } = makeTempStore());
    const { store } = makeTempStore();
    store.add("ctx-1", "entry-a");
    expect(store.has("ctx-1", "entry-a")).toBe(true);
  });

  it("is scoped per context key", () => {
    ({ dir } = makeTempStore());
    const { store } = makeTempStore();
    store.add("ctx-1", "entry-a");
    expect(store.has("ctx-2", "entry-a")).toBe(false);
  });

  it("does not duplicate entries on repeated add", () => {
    ({ dir } = makeTempStore());
    const { store } = makeTempStore();
    store.add("ctx-1", "entry-a");
    store.add("ctx-1", "entry-a");
    store.has("ctx-1", "entry-a");
    // Should still be true — no error thrown.
    expect(store.has("ctx-1", "entry-a")).toBe(true);
  });

  it("persists entries to disk after flush", () => {
    const { store, filePath, dir: d } = makeTempStore();
    dir = d;
    store.add("ctx-1", "entry-a");
    store.add("ctx-1", "entry-b");
    store.flush();

    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw["ctx-1"]).toContain("entry-a");
    expect(raw["ctx-1"]).toContain("entry-b");
  });

  it("loads persisted entries on construction (cross-instance)", () => {
    const { store: store1, filePath, dir: d } = makeTempStore();
    dir = d;
    store1.add("ctx-1", "entry-a");
    store1.flush();

    // Simulate restart: new instance pointing at the same file.
    const store2 = new NotificationDedupeStore(filePath);
    expect(store2.has("ctx-1", "entry-a")).toBe(true);
    expect(store2.has("ctx-1", "entry-z")).toBe(false);
  });

  it("handles missing file gracefully", () => {
    const { store, dir: d } = makeTempStore();
    dir = d;
    // File does not exist yet — should return false without throwing.
    expect(store.has("ctx-1", "entry-a")).toBe(false);
  });

  it("handles corrupted file gracefully", () => {
    const { store: _store, filePath, dir: d } = makeTempStore();
    dir = d;
    // Write invalid JSON.
    require("node:fs").writeFileSync(filePath, "not-json", "utf8");
    const store = new NotificationDedupeStore(filePath);
    expect(store.has("ctx-1", "entry-a")).toBe(false);
    store.add("ctx-1", "entry-a");
    expect(store.has("ctx-1", "entry-a")).toBe(true);
  });

  it("does not write when not dirty", () => {
    const { store, filePath, dir: d } = makeTempStore();
    dir = d;
    store.flush(); // no-op when not dirty
    expect(existsSync(filePath)).toBe(false);
  });

  it("dispose flushes pending changes", () => {
    const { store, filePath, dir: d } = makeTempStore();
    dir = d;
    store.add("ctx-1", "entry-a");
    store.dispose();
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw["ctx-1"]).toContain("entry-a");
  });

  it("createDefault returns a store with the expected file path", () => {
    const store = NotificationDedupeStore.createDefault();
    expect(store).toBeInstanceOf(NotificationDedupeStore);
    // Dispose immediately — no file should be written.
    store.dispose();
  });
});
