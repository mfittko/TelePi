import { describe, it, expect, vi } from "vitest";

import {
  ACTIONABLE_CUSTOM_TYPES,
  isActionableCustomMessageEntry,
  formatNotification,
  sanitizeNotificationText,
  createSessionNotificationWatcher,
} from "../../src/session-notification-watcher.js";
import type { CustomMessageEntry, SessionEntry } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// sanitizeNotificationText
// ---------------------------------------------------------------------------

describe("sanitizeNotificationText", () => {
  it("returns plain text unchanged", () => {
    expect(sanitizeNotificationText("Task completed successfully.")).toBe("Task completed successfully.");
  });

  it("strips file:// URIs", () => {
    const input = "Report saved to file:///home/user/report.pdf for review.";
    // file:// URI is removed; whitespace is collapsed to single space
    const result = sanitizeNotificationText(input);
    expect(result).not.toContain("file://");
    expect(result).toContain("Report saved to");
    expect(result).toContain("for review.");
  });

  it("replaces /home/ absolute paths with placeholder", () => {
    const input = "See /home/user/project/output.txt for details.";
    expect(sanitizeNotificationText(input)).toBe("See [local path] for details.");
  });

  it("replaces /Users/ absolute paths (macOS)", () => {
    // The trailing period is part of the regex match (consumed with the path)
    const result = sanitizeNotificationText("Output at /Users/name/Desktop/result.md.");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("/Users/");
  });

  it("replaces /tmp/ paths", () => {
    const result = sanitizeNotificationText("Temp file at /tmp/run-123/artifact.zip");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("/tmp/");
  });

  it("replaces /workspace/ paths (Docker)", () => {
    const result = sanitizeNotificationText("Build artifacts are at /workspace/dist/app.js");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("/workspace/");
  });

  it("keeps relative paths", () => {
    const input = "Error in src/main.ts at line 42.";
    expect(sanitizeNotificationText(input)).toBe("Error in src/main.ts at line 42.");
  });

  it("collapses extra whitespace after removal", () => {
    const input = "See file:///tmp/file.txt  for details";
    const result = sanitizeNotificationText(input);
    expect(result).not.toContain("  ");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeNotificationText("  hello  ")).toBe("hello");
  });

  it("handles empty string", () => {
    expect(sanitizeNotificationText("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// isActionableCustomMessageEntry
// ---------------------------------------------------------------------------

describe("isActionableCustomMessageEntry", () => {
  it("accepts subagent-notify with display=true", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true);
    expect(isActionableCustomMessageEntry(entry)).toBe(true);
  });

  it("accepts subagent_control_notice with display=true", () => {
    const entry = makeCustomMessageEntry("subagent_control_notice", true);
    expect(isActionableCustomMessageEntry(entry)).toBe(true);
  });

  it("rejects subagent-notify with display=false", () => {
    const entry = makeCustomMessageEntry("subagent-notify", false);
    expect(isActionableCustomMessageEntry(entry)).toBe(false);
  });

  it("rejects non-whitelisted custom_message types", () => {
    const entry = makeCustomMessageEntry("some-other-type", true);
    expect(isActionableCustomMessageEntry(entry)).toBe(false);
  });

  it("rejects ordinary message entries", () => {
    const entry = makeSessionEntry();
    expect(isActionableCustomMessageEntry(entry)).toBe(false);
  });

  it("rejects tool entries", () => {
    const entry = makeSessionEntry({
      type: "message",
      message: { role: "tool", content: "output" } as any,
    });
    expect(isActionableCustomMessageEntry(entry)).toBe(false);
  });

  it("covers all ACTIONABLE_CUSTOM_TYPES", () => {
    for (const customType of ACTIONABLE_CUSTOM_TYPES) {
      const entry = makeCustomMessageEntry(customType, true);
      expect(isActionableCustomMessageEntry(entry)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatNotification — subagent-notify
// ---------------------------------------------------------------------------

describe("formatNotification — subagent-notify", () => {
  it("formats completed status without content", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      status: "completed",
      agent: "my-agent",
    });
    expect(formatNotification(entry)).toBe("✅ Background task completed: my-agent");
  });

  it("formats completed status with LLM-generated content body", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "completed", agent: "my-agent" },
      "All 42 tests passed. The deployment succeeded.",
    );
    expect(formatNotification(entry)).toBe(
      "✅ Background task completed: my-agent\nAll 42 tests passed. The deployment succeeded.",
    );
  });

  it("sanitizes local paths from content body", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "completed", agent: "builder" },
      "Artifacts written to /home/user/dist/app.js.",
    );
    const result = formatNotification(entry);
    expect(result).toContain("✅ Background task completed: builder");
    expect(result).toContain("[local path]");
    expect(result).not.toContain("/home/");
  });

  it("sanitizes file:// URIs from content body", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "completed" },
      "Report at file:///home/user/report.html ready.",
    );
    const result = formatNotification(entry);
    expect(result).toContain("✅ Background task completed");
    expect(result).not.toContain("file://");
    expect(result).not.toContain("/home/");
  });

  it("formats done status as completed", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "done" });
    expect(formatNotification(entry)).toBe("✅ Background task completed");
  });

  it("formats success status as completed", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "success" });
    expect(formatNotification(entry)).toBe("✅ Background task completed");
  });

  it("formats failed status without content", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      status: "failed",
      agentName: "bot",
    });
    expect(formatNotification(entry)).toBe("❌ Background task failed: bot");
  });

  it("formats failed status with error summary", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "failed", agent: "compiler" },
      "Build failed: 3 TypeScript errors in src/main.ts.",
    );
    expect(formatNotification(entry)).toBe(
      "❌ Background task failed: compiler\nBuild failed: 3 TypeScript errors in src/main.ts.",
    );
  });

  it("formats error status as failed", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "error" });
    expect(formatNotification(entry)).toBe("❌ Background task failed");
  });

  it("formats paused status without content", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      status: "paused",
      name: "worker",
    });
    expect(formatNotification(entry)).toBe("⏸ Background task paused: worker");
  });

  it("formats paused status with content body", () => {
    const entry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "paused", agent: "scraper" },
      "Waiting for approval to proceed.",
    );
    expect(formatNotification(entry)).toBe(
      "⏸ Background task paused: scraper\nWaiting for approval to proceed.",
    );
  });

  it("falls back to notice field for unknown status", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      notice: "Something happened",
    });
    expect(formatNotification(entry)).toBe("🔔 Subagent notification: Something happened");
  });

  it("falls back to content when no details (unknown status)", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, undefined, "Task done.");
    expect(formatNotification(entry)).toBe("🔔 Subagent notification: Task done.");
  });

  it("truncates long content body with ellipsis", () => {
    const long = "x".repeat(300);
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" }, long);
    const result = formatNotification(entry);
    expect(result).toContain("✅ Background task completed");
    expect(result).toContain("…");
    expect(result.endsWith("…")).toBe(true);
    const bodyLine = result.split("\n")[1];
    expect(bodyLine.replace("…", "").length).toBe(200);
  });

  it("returns header only when content is empty for known status", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true);
    expect(formatNotification(entry)).toBe("🔔 Subagent notification");
  });

  it("returns empty string for unknown customType", () => {
    const entry = makeCustomMessageEntry("unknown-type", true, { status: "completed" });
    expect(formatNotification(entry)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatNotification — subagent_control_notice
// ---------------------------------------------------------------------------

describe("formatNotification — subagent_control_notice", () => {
  it("formats needs_attention event without content", () => {
    const entry = makeCustomMessageEntry("subagent_control_notice", true, {
      event: "needs_attention",
      agent: "my-agent",
    });
    expect(formatNotification(entry)).toBe("⚠️ Subagent needs attention: my-agent");
  });

  it("formats needs_attention with LLM-generated content body", () => {
    const entry = makeCustomMessageEntry(
      "subagent_control_notice",
      true,
      { event: "needs_attention", agent: "my-agent" },
      "The agent is waiting for a decision on the conflicting merge.",
    );
    expect(formatNotification(entry)).toBe(
      "⚠️ Subagent needs attention: my-agent\nThe agent is waiting for a decision on the conflicting merge.",
    );
  });

  it("sanitizes local paths from needs_attention content", () => {
    const entry = makeCustomMessageEntry(
      "subagent_control_notice",
      true,
      { event: "needs_attention" },
      "Please review /home/user/workspace/diff.patch before continuing.",
    );
    const result = formatNotification(entry);
    expect(result).toContain("⚠️ Subagent needs attention");
    expect(result).not.toContain("/home/");
    expect(result).toContain("[local path]");
  });

  it("formats needsAttention event variant", () => {
    const entry = makeCustomMessageEntry("subagent_control_notice", true, {
      event: "needsAttention",
    });
    expect(formatNotification(entry)).toBe("⚠️ Subagent needs attention");
  });

  it("falls back to notice when no needs_attention event", () => {
    const entry = makeCustomMessageEntry("subagent_control_notice", true, {
      notice: "Please check the run",
    });
    expect(formatNotification(entry)).toBe("⚠️ Subagent notice: Please check the run");
  });

  it("falls back to content", () => {
    const entry = makeCustomMessageEntry(
      "subagent_control_notice",
      true,
      undefined,
      "Attention required",
    );
    expect(formatNotification(entry)).toBe("⚠️ Subagent notice: Attention required");
  });

  it("returns plain fallback when no useful text", () => {
    const entry = makeCustomMessageEntry("subagent_control_notice", true);
    expect(formatNotification(entry)).toBe("⚠️ Subagent notice");
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — catch-up
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — catch-up", () => {
  it("sends notifications for existing actionable entries not yet seen", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed", agent: "a1" });
    const session = makeMockSession([entry]);
    const send = vi.fn();
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledOnce();
    // No content body — header only.
    expect(send).toHaveBeenCalledWith("✅ Background task completed: a1");
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
    const send = vi.fn();
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledWith(
      "✅ Background task completed: a1\nAll tests passed. The PR is ready to merge.",
    );
  });

  it("skips entries that are already seen", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn();
    const seen = new Set<string>(["entry-1"]);

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips non-whitelisted custom_message entries", () => {
    const entry = makeCustomMessageEntry("other-type", true);
    const session = makeMockSession([entry]);
    const send = vi.fn();
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips display=false entries", () => {
    const entry = makeCustomMessageEntry("subagent-notify", false, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn();
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("skips ordinary session message entries", () => {
    const msgEntry = makeSessionEntry();
    const session = makeMockSession([msgEntry]);
    const send = vi.fn();
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
    const send = vi.fn();
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).toHaveBeenCalledTimes(2);
    // No content on either entry — header only.
    expect(send).toHaveBeenNthCalledWith(1, "✅ Background task completed: a1");
    expect(send).toHaveBeenNthCalledWith(2, "❌ Background task failed: a2");
  });
});

// ---------------------------------------------------------------------------
// createSessionNotificationWatcher — live events
// ---------------------------------------------------------------------------

describe("createSessionNotificationWatcher — live events", () => {
  it("sends notification on message_end for actionable custom message", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed", agent: "live-agent" });
    const session = makeMockSession([entry]);
    const send = vi.fn();
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
    const send = vi.fn();
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
    const send = vi.fn();
    const seen = new Set<string>();

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });

    expect(send).not.toHaveBeenCalled();
  });

  it("ignores non-whitelisted customType in live events", () => {
    const session = makeMockSession([]);
    const send = vi.fn();
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
    const send = vi.fn();
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
    const send = vi.fn();
    const seen = new Set<string>(["entry-1"]);

    createSessionNotificationWatcher(session as any, (id) => seen.has(id), (id) => seen.add(id), send);

    expect(send).not.toHaveBeenCalled();
  });

  it("deduplicates across watcher rebind (same seen set)", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "completed" });
    const session = makeMockSession([entry]);
    const send = vi.fn();
    const seen = new Set<string>();

    // First watcher attach — sends the notification and marks it seen.
    const unsub1 = createSessionNotificationWatcher(
      session as any,
      (id) => seen.has(id),
      (id) => seen.add(id),
      send,
    );
    expect(send).toHaveBeenCalledOnce();
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
    const sendA = vi.fn();
    const seenA = new Set<string>();
    createSessionNotificationWatcher(
      sessionA as any,
      (id) => seenA.has(id),
      (id) => seenA.add(id),
      sendA,
    );

    // Context B — same entry, separate seen set
    const sessionB = makeMockSession([entry]);
    const sendB = vi.fn();
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

  it("uses fallback id for live events when entry not found in session", () => {
    const session = makeMockSession([]); // no entries
    const send = vi.fn();
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
    expect(seen.has(`subagent-notify::${ts}`)).toBe(true);

    // Emitting the same event again should NOT resend.
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
    const send = vi.fn();
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
