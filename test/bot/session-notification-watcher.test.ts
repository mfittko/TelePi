import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  };
});

import {
  ACTIONABLE_CUSTOM_TYPES,
  isActionableCustomMessageEntry,
  formatNotification,
  sanitizeNotificationText,
  createSessionNotificationWatcher,
} from "../../src/session-notification-watcher.js";
import type { CustomMessageEntry, SessionEntry } from "@mariozechner/pi-coding-agent";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fs.watchFile).mockReset();
  vi.mocked(fs.unwatchFile).mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCustomMessageEntry(
  customType: string,
  display: boolean,
  details?: unknown,
  content = "",
  id = "entry-1",
): CustomMessageEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    customType,
    content,
    display,
    details,
  };
}

function makeSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    type: "message",
    id: "msg-1",
    parentId: null,
    timestamp: "2025-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello" },
    ...overrides,
  } as SessionEntry;
}

function makeMockSession(entries: SessionEntry[] = []) {
  const subscribers: Array<(event: any) => void> = [];

  return {
    sessionManager: {
      getEntries: vi.fn(() => [...entries]),
    },
    subscribe: vi.fn((listener: (event: any) => void) => {
      subscribers.push(listener);
      return () => {
        const idx = subscribers.indexOf(listener);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }),
    emit: (event: any) => {
      for (const sub of subscribers) {
        sub(event);
      }
    },
    subscribers,
  };
}

// ---------------------------------------------------------------------------
// notification formatting
// ---------------------------------------------------------------------------

describe("sanitizeNotificationText", () => {
  it.each([
    ["file:///tmp/out.log", ""],
    ["See /Users/me/project/secret.txt", "See [local path]"],
    ["See /tmp/out.log", "See [local path]"],
    ["Keep relative/path.md", "Keep relative/path.md"],
  ])("sanitizes %s", (input, expected) => {
    expect(sanitizeNotificationText(input)).toBe(expected);
  });
});

describe("isActionableCustomMessageEntry", () => {
  it("accepts only displayed whitelisted custom messages", () => {
    expect(isActionableCustomMessageEntry(makeCustomMessageEntry("subagent-notify", true))).toBe(true);
    expect(isActionableCustomMessageEntry(makeCustomMessageEntry("subagent_control_notice", true))).toBe(true);
    expect(isActionableCustomMessageEntry(makeCustomMessageEntry("subagent-notify", false))).toBe(false);
    expect(isActionableCustomMessageEntry(makeCustomMessageEntry("other", true))).toBe(false);
    expect(isActionableCustomMessageEntry(makeSessionEntry())).toBe(false);
  });
});

describe("formatNotification", () => {
  it("formats completed subagent output with useful content and no local metadata", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      undefined,
      [
        "Background task completed: **worker**",
        "Implemented formatter changes.",
        "Output saved to: /tmp/output.md (1 KB, 2 lines). Read this file if needed.",
        "Session file: /tmp/session.jsonl",
      ].join("\n"),
    );

    expect(formatNotification(entry)).toBe("✅ Background task completed: worker\nImplemented formatter changes.");
  });

  it("formats parallel reviewer summaries without exposing file paths", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      undefined,
      [
        "Background task completed: **parallel:reviewer+reviewer+reviewer**",
        "reviewer:",
        "Output saved to: /Users/me/review-a.md (1 KB, 3 lines). Read this file if needed.",
        "reviewer:",
        "Output saved to: /Users/me/review-b.md (1 KB, 3 lines). Read this file if needed.",
        "reviewer:",
        "Output saved to: /Users/me/review-c.md (1 KB, 3 lines). Read this file if needed.",
      ].join("\n"),
    );

    expect(formatNotification(entry)).toBe("✅ Background task completed: 3 reviewers\n3 reviewers completed successfully.");
  });

  it("uses injected summaries from enriched output files", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      undefined,
      [
        "Background task completed: **parallel:reviewer+reviewer+reviewer**",
        "reviewer:",
        "Output saved to: /tmp/review.md (1 KB, 3 lines). Read this file if needed.",
        "Summary: One blocker remains: bootstrap attach can race. Everything else reviewed well.",
      ].join("\n"),
    );

    expect(formatNotification(entry)).toBe(
      "✅ Background task completed: 3 reviewers\nOne blocker remains: bootstrap attach can race. Everything else reviewed well.",
    );
  });

  it("distinguishes useful work that failed while finalizing from task failure", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      undefined,
      [
        "Background task failed: **worker**",
        "Implemented notification changes.",
        "Validation: focused tests passed.",
        "Runtime issue: agent server error while finalizing.",
      ].join("\n"),
    );

    expect(formatNotification(entry)).toBe(
      "⚠️ Background task partly completed: worker\nWork finished and validation passed. The run was marked failed because the agent hit a runtime issue while finalizing.",
    );
  });

  it("formats failures, pauses, control notices, and unknown notices", () => {
    expect(formatNotification(makeCustomMessageEntry("subagent-notify", true, { status: "failed", agent: "worker" })))
      .toBe("❌ Background task failed: worker");
    expect(formatNotification(makeCustomMessageEntry("subagent-notify", true, { status: "paused", agent: "worker" }, "Waiting.")))
      .toBe("⏸ Background task paused: worker\nWaiting.");
    expect(formatNotification(makeCustomMessageEntry("subagent_control_notice", true, { event: "needs_attention", agent: "reviewer" }, "Needs input.")))
      .toBe("⚠️ Subagent needs attention: reviewer\nNeeds input.");
    expect(formatNotification(makeCustomMessageEntry("other", true))).toBe("");
  });

  it("keeps concise summaries long enough to include useful context", () => {
    const useful = "A".repeat(650);
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed", agent: "worker" }, useful);

    expect(formatNotification(entry)).toContain(useful);
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — catch-up
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — catch-up", () => {
  it("sends notifications for existing actionable entries not yet seen", async () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed", agent: "a1" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledOnce();
    // No content body — header only.
    expect(send).toHaveBeenCalledWith("✅ Background task completed: a1");
    // markSeen is async — flush microtasks before asserting.
    await Promise.resolve();
    expect(seen.has("entry-1")).toBe(true);
  });

  it("includes LLM-generated content body in catch-up notification", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "completed", agent: "a1" },
      "All tests passed. The PR is ready to merge.",
    );
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledWith(
      "✅ Background task completed: a1\nAll tests passed. The PR is ready to merge.",
    );
  });

  it("skips entries that are already seen", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>(["entry-1"]);

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips non-whitelisted custom_message entries", () => {
    const entry = makeCustomMessageEntry("other-type", true);
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips display=false entries", () => {
    const entry = makeCustomMessageEntry("subagent-notify", false, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips ordinary session message entries", () => {
    const msgEntry = makeSessionEntry();
    const session = makeMockSession([msgEntry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("processes multiple actionable entries in order", () => {
    const entries = [
      makeCustomMessageEntry("subagent-notify", true, { status: "completed", agent: "a1" }, "", "id-1"),
      makeCustomMessageEntry("subagent-notify", true, { status: "failed", agent: "a2" }, "", "id-2"),
    ];
    const session = makeMockSession(entries);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledTimes(2);
    // No content on either entry — header only.
    expect(send).toHaveBeenNthCalledWith(1, "✅ Background task completed: a1");
    expect(send).toHaveBeenNthCalledWith(2, "❌ Background task failed: a2");
  });

  it("does not mark as seen when send fails", async () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockRejectedValue(new Error("Telegram error"));
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledOnce();
    // Flush microtasks — the rejection handler runs, but markSeen must NOT have been called.
    await Promise.resolve();
    expect(seen.has("entry-1")).toBe(false);
  });

  it("retries delivery on next watcher attach after a previous send failure", async () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const seen = new Set<string>();

    // First attach — send fails, entry stays un-marked.
    const send1 = vi.fn().mockRejectedValue(new Error("network error"));
    const unsub1 = createSessionNotificationWatcher(
      session as any,
      (id) => seen.has(id),
      (id) => seen.add(id),
      send1,
    );
    await Promise.resolve(); // flush rejection — markSeen NOT called
    unsub1();

    // Second attach (rebind after reconnect) — send now succeeds.
    const send2 = vi.fn().mockResolvedValue(undefined);
    createSessionNotificationWatcher(
      session as any,
      (id) => seen.has(id),
      (id) => seen.add(id),
      send2,
    );
    // Entry is still not seen — should be retried.
    expect(send2).toHaveBeenCalledOnce();
    await Promise.resolve(); // flush — markSeen called this time
    expect(seen.has("entry-1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — file tail robustness
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — file tail robustness", () => {
  it("summarizes referenced output files before sending Telegram notifications", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), "reviews", "telepi-output-summary-"));
    const outputFile = path.join(dir, "review.md");
    writeFileSync(outputFile, "## Review\n- Blocker: bootstrap path can attach to the wrong chat. Fix the reservation.\n- Correct: JSONL tailing works.\n", "utf8");

    try {
      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        undefined,
        [
          "Background task completed: **parallel:reviewer+reviewer+reviewer**",
          "",
          "reviewer:",
          `Output saved to: ${outputFile} (1 KB, 6 lines). Read this file if needed.`,
          "",
          "Session file: /tmp/nonexistent-child-session.jsonl",
        ].join("\n"),
        "output-summary-entry",
      );
      const session = makeMockSession([entry]);
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();

      createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith(
        "✅ Background task completed: 3 reviewers\nOne blocker remains: bootstrap path can attach to the wrong chat. Everything else reviewed well.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts local paths from referenced output summaries", async () => {
    const dir = mkdtempSync(path.join(process.cwd(), "reviews", "telepi-output-redact-"));
    const outputFile = path.join(dir, "review.md");
    writeFileSync(outputFile, "## Review\n- Blocker: inspect /Users/example/project/secret.txt before merging.\n", "utf8");

    try {
      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        undefined,
        [
          "Background task completed: **reviewer**",
          `Output saved to: ${outputFile} (1 KB, 2 lines). Read this file if needed.`,
          "Session file: /tmp/nonexistent-child-session.jsonl",
        ].join("\n"),
        "redacted-output-summary-entry",
      );
      const session = makeMockSession([entry]);
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();

      createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith(
        "✅ Background task completed: reviewer\nOne blocker remains: inspect [local path] before merging. Everything else reviewed well.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not summarize output files outside allowed roots", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-output-unsafe-"));
    const outputFile = path.join(dir, "review.md");
    writeFileSync(outputFile, "## Review\n- Blocker: this unsafe file should not be read.\n", "utf8");

    try {
      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        undefined,
        [
          "Background task completed: **reviewer**",
          `Output saved to: ${outputFile} (1 KB, 2 lines). Read this file if needed.`,
          "Session file: /tmp/nonexistent-child-session.jsonl",
        ].join("\n"),
        "unsafe-output-summary-entry",
      );
      const session = makeMockSession([entry]);
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();

      createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith("✅ Background task completed: reviewer");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enriches failed completion notifications from async status metadata", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-status-watch-"));
    const childSessionFile = path.join(dir, "child-session.jsonl");
    const asyncBase = path.join(
      tmpdir(),
      `pi-subagents-uid-${typeof process.getuid === "function" ? process.getuid() : "undefined"}`,
      "async-subagent-runs",
    );
    mkdirSync(asyncBase, { recursive: true });
    const runDir = mkdtempSync(path.join(asyncBase, "telepi-test-"));

    try {
      writeFileSync(childSessionFile, "", "utf8");
      writeFileSync(
        path.join(runDir, "status.json"),
        JSON.stringify({
          state: "failed",
          steps: [{
            status: "failed",
            sessionFile: childSessionFile,
            error: "Codex error: server_error while finalizing",
          }],
        }),
        "utf8",
      );

      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        undefined,
        [
          "Background task failed: **worker**",
          "",
          "worker:",
          "Implemented the notification formatter fix and added regression tests.",
          "Validation: focused tests passed.",
          `Session file: ${childSessionFile}`,
        ].join("\n"),
        "status-enriched-entry",
      );
      const session = makeMockSession([entry]);
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();

      createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith(
        "⚠️ Background task partly completed: worker\nWork finished and validation passed. The run was marked failed because the agent hit a runtime issue while finalizing.",
      );
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the newest matching async status when historical runs reference the same session", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-status-newest-"));
    const childSessionFile = path.join(dir, "child-session.jsonl");
    const asyncBase = path.join(
      tmpdir(),
      `pi-subagents-uid-${typeof process.getuid === "function" ? process.getuid() : "undefined"}`,
      "async-subagent-runs",
    );
    mkdirSync(asyncBase, { recursive: true });
    const oldRunDir = mkdtempSync(path.join(asyncBase, "telepi-test-old-"));
    const newRunDir = mkdtempSync(path.join(asyncBase, "telepi-test-new-"));

    try {
      writeFileSync(childSessionFile, "", "utf8");
      const oldStatus = path.join(oldRunDir, "status.json");
      const newStatus = path.join(newRunDir, "status.json");
      writeFileSync(
        oldStatus,
        JSON.stringify({
          state: "failed",
          steps: [{ status: "failed", sessionFile: childSessionFile, error: "old stale runtime error" }],
        }),
        "utf8",
      );
      writeFileSync(
        newStatus,
        JSON.stringify({
          state: "failed",
          steps: [{ status: "failed", sessionFile: childSessionFile, error: "Codex error: server_error newest" }],
        }),
        "utf8",
      );
      fs.utimesSync(oldStatus, new Date("2025-01-01T00:00:00Z"), new Date("2025-01-01T00:00:00Z"));
      fs.utimesSync(newStatus, new Date("2025-01-02T00:00:00Z"), new Date("2025-01-02T00:00:00Z"));

      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        undefined,
        [
          "Background task failed: **worker**",
          "Implemented the notification formatter fix and added regression tests.",
          "Validation: focused tests passed.",
          `Session file: ${childSessionFile}`,
        ].join("\n"),
        "status-newest-entry",
      );
      const session = makeMockSession([entry]);
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();

      createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith(
        "⚠️ Background task partly completed: worker\nWork finished and validation passed. The run was marked failed because the agent hit a runtime issue while finalizing.",
      );
    } finally {
      rmSync(oldRunDir, { recursive: true, force: true });
      rmSync(newRunDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buffers partial JSONL appends until the line is complete", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-session-watch-"));
    const sessionFile = path.join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");

    try {
      const session = { ...makeMockSession([]), sessionFile };
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();
      let drainFile!: () => void;
      vi.mocked(fs.watchFile).mockImplementation((_file, _options, listener) => {
        drainFile = listener as () => void;
        return undefined as any;
      });

      const unsubscribe = createSessionNotificationWatcher(
        session as any,
        (id) => seen.has(id),
        (id) => seen.add(id),
        send,
      );

      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        { status: "completed", agent: "partial" },
        "Partial write recovered successfully.",
        "partial-entry",
      );
      const json = JSON.stringify(entry);
      appendFileSync(sessionFile, json.slice(0, Math.floor(json.length / 2)), "utf8");

      drainFile();
      await Promise.resolve();
      expect(send).not.toHaveBeenCalled();

      appendFileSync(sessionFile, `${json.slice(Math.floor(json.length / 2))}\n`, "utf8");
      drainFile();
      await Promise.resolve();

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(
        "✅ Background task completed: partial\nPartial write recovered successfully.",
      );
      expect(seen.has("partial-entry")).toBe(true);
      unsubscribe();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delivers entries appended during the startup gap after watcher registration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-session-watch-"));
    const sessionFile = path.join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");

    try {
      const session = { ...makeMockSession([]), sessionFile };
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();
      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        { status: "completed", agent: "startup-gap" },
        "Appended during startup.",
        "startup-gap-entry",
      );

      vi.mocked(fs.watchFile).mockImplementation((_file, _options, _listener) => {
        appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
        return undefined as any;
      });

      const unsubscribe = createSessionNotificationWatcher(
        session as any,
        (id) => seen.has(id),
        (id) => seen.add(id),
        send,
      );

      await Promise.resolve();
      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(
        "✅ Background task completed: startup-gap\nAppended during startup.",
      );
      expect(seen.has("startup-gap-entry")).toBe(true);
      unsubscribe();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — live events
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — live events", () => {
  it("tails the session file for externally appended actionable custom messages", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-session-watch-"));
    const sessionFile = path.join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");

    try {
      const session = { ...makeMockSession([]), sessionFile };
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();
      let drainFile!: () => void;
      vi.mocked(fs.watchFile).mockImplementation((_file, _options, listener) => {
        drainFile = listener as () => void;
        return undefined as any;
      });

      const unsubscribe = createSessionNotificationWatcher(
        session as any,
        (id) => seen.has(id),
        (id) => seen.add(id),
        send,
      );

      const entry = makeCustomMessageEntry(
        "subagent-notify",
        true,
        { status: "completed", agent: "external" },
        "Planner run finished successfully.",
        "external-entry",
      );
      appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
      drainFile();
      await Promise.resolve();

      expect(send).toHaveBeenCalledWith(
        "✅ Background task completed: external\nPlanner run finished successfully.",
      );
      expect(seen.has("external-entry")).toBe(true);
      unsubscribe();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends notification on message_end for actionable custom message", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed", agent: "live-agent" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    // Mark the catch-up entry as already sent to isolate the live event.
    // Reset and inject a new entry for the live path (with summary content).
    const newEntry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "paused", agent: "live-agent" },
      "Waiting for user input to continue.",
      "entry-live",
    );
    session.sessionManager.getEntries.mockReturnValue([entry, newEntry]);
    send.mockClear();

    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        display: true,
        timestamp: Date.now(),
      },
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      "⏸ Background task paused: live-agent\nWaiting for user input to continue.",
    );
  });

  it("ignores non-custom message_end events", () => {
    const session = makeMockSession([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    session.emit({
      type: "message_end",
      message: { role: "assistant", content: "hello" },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("ignores message_update events", () => {
    const session = makeMockSession([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });

    expect(send).not.toHaveBeenCalled();
  });

  it("ignores non-whitelisted customType in live events", () => {
    const session = makeMockSession([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    session.emit({
      type: "message_end",
      message: { role: "custom", customType: "other-type", display: true, timestamp: Date.now() },
    });

    expect(send).not.toHaveBeenCalled();
  });

  it("ignores display=false in live events", () => {
    const session = makeMockSession([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        display: false,
        timestamp: Date.now(),
      },
    });

    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — dedupe
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — dedupe", () => {
  it("does not re-send a notification already in seenIds", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>(["entry-1"]);

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("deduplicates across watcher rebind (same seen set)", async () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    // First watcher attach — sends the notification.
    const unsub1 = createSessionNotificationWatcher(
      session as any,
      (id) => seen.has(id),
      (id) => seen.add(id),
      send,
    );
    expect(send).toHaveBeenCalledOnce();
    // Flush microtasks so markSeen runs before the second attach.
    await Promise.resolve();
    unsub1();

    // Second watcher attach (rebind) with the same seen set — should NOT resend.
    createSessionNotificationWatcher(
      session as any,
      (id) => seen.has(id),
      (id) => seen.add(id),
      send,
    );
    expect(send).toHaveBeenCalledOnce(); // still only one call total
  });

  it("does not suppress a notification for a different chat/topic (different seen set)", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });

    // Context A
    const sessionA = makeMockSession([entry]);
    const sendA = vi.fn().mockResolvedValue(undefined);
    const seenA = new Set<string>();
    createSessionNotificationWatcher(
      sessionA as any,
      (id) => seenA.has(id),
      (id) => seenA.add(id),
      sendA,
    );

    // Context B — same entry, separate seen set
    const sessionB = makeMockSession([entry]);
    const sendB = vi.fn().mockResolvedValue(undefined);
    const seenB = new Set<string>();
    createSessionNotificationWatcher(
      sessionB as any,
      (id) => seenB.has(id),
      (id) => seenB.add(id),
      sendB,
    );

    expect(sendA).toHaveBeenCalledOnce();
    expect(sendB).toHaveBeenCalledOnce();
  });

  it("uses the tailed real entry instead of a fallback id when a session file is available", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "telepi-live-tail-"));
    const sessionFile = path.join(dir, "session.jsonl");
    writeFileSync(sessionFile, "", "utf8");

    try {
      const session = makeMockSession([]) as any;
      session.sessionFile = sessionFile;
      const send = vi.fn().mockResolvedValue(undefined);
      const seen = new Set<string>();

      createSessionNotificationWatcher(session, (id) => seen.has(id), (id) => seen.add(id), send);

      const realEntry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" }, "Background task completed: **worker**", "real-entry-id");
      appendFileSync(sessionFile, `${JSON.stringify(realEntry)}\n`, "utf8");

      const ts = 1700000000000;
      session.emit({
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent-notify",
          display: true,
          timestamp: ts,
          details: { status: "completed" },
        },
      });

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith("✅ Background task completed: worker");
      await Promise.resolve();
      expect(seen.has("real-entry-id")).toBe(true);
      expect(seen.has(`subagent-notify::${ts}`)).toBe(false);

      send.mockClear();
      session.emit({
        type: "message_end",
        message: {
          role: "custom",
          customType: "subagent-notify",
          display: true,
          timestamp: ts,
          details: { status: "completed" },
        },
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses fallback id for live events when entry not found in session", async () => {
    const session = makeMockSession([]); // no entries
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    const ts = 1700000000000;
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        display: true,
        timestamp: ts,
        details: { status: "completed" },
      },
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("✅ Background task completed");
    // Flush microtasks so markSeen runs.
    await Promise.resolve();
    expect(seen.has(`subagent-notify::${ts}`)).toBe(true);

    // Emitting the same event again should NOT resend (isAlreadySeen is now true).
    send.mockClear();
    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        display: true,
        timestamp: ts,
        details: { status: "completed" },
      },
    });

    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — unsubscribe
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — unsubscribe", () => {
  it("stops delivering events after unsubscribe", () => {
    const session = makeMockSession([]);
    const send = vi.fn().mockResolvedValue(undefined);
    const seen = new Set<string>();

    const unsub = createSessionNotificationWatcher(
      session as any,
      (id) => seen.has(id),
      (id) => seen.add(id),
      send,
    );

    unsub();

    const newEntry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    session.sessionManager.getEntries.mockReturnValue([newEntry]);

    session.emit({
      type: "message_end",
      message: {
        role: "custom",
        customType: "subagent-notify",
        display: true,
        timestamp: Date.now(),
      },
    });

    expect(send).not.toHaveBeenCalled();
  });
});
