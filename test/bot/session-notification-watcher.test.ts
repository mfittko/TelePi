import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  ACTIONABLE_CUSTOM_TYPES,
  isActionableCustomMessageEntry,
  formatNotification,
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
  it("formats completed status", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      status: "completed",
      agent: "my-agent",
    });
    expect(formatNotification(entry)).toBe("✅ Background task completed: my-agent");
  });

  it("formats done status as completed", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "done" });
    expect(formatNotification(entry)).toBe("✅ Background task completed");
  });

  it("formats success status as completed", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "success" });
    expect(formatNotification(entry)).toBe("✅ Background task completed");
  });

  it("formats failed status", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      status: "failed",
      agentName: "bot",
    });
    expect(formatNotification(entry)).toBe("❌ Background task failed: bot");
  });

  it("formats error status as failed", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, { status: "error" });
    expect(formatNotification(entry)).toBe("❌ Background task failed");
  });

  it("formats paused status", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      status: "paused",
      name: "worker",
    });
    expect(formatNotification(entry)).toBe("⏸ Background task paused: worker");
  });

  it("falls back to notice field", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, {
      notice: "Something happened",
    });
    expect(formatNotification(entry)).toBe("🔔 Subagent notification: Something happened");
  });

  it("falls back to content when no details", () => {
    const entry = makeCustomMessageEntry("subagent-notify", true, undefined, "Task done.");
    expect(formatNotification(entry)).toBe("🔔 Subagent notification: Task done.");
  });

  it("truncates long content to 200 chars", () => {
    const long = "x".repeat(300);
    const entry = makeCustomMessageEntry("subagent-notify", true, undefined, long);
    const result = formatNotification(entry);
    expect(result).toContain("🔔 Subagent notification:");
    expect(result.length).toBeLessThanOrEqual("🔔 Subagent notification: ".length + 200 + 5);
  });

  it("returns fallback when entry has no useful text", () => {
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
  it("formats needs_attention event", () => {
    const entry = makeCustomMessageEntry("subagent_control_notice", true, {
      event: "needs_attention",
      agent: "my-agent",
    });
    expect(formatNotification(entry)).toBe("⚠️ Subagent needs attention: my-agent");
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
      run: "run-42",
    });
    expect(formatNotification(entry)).toBe("⚠️ Subagent notice: run-42: Please check the run");
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
    expect(send).toHaveBeenCalledWith("✅ Background task completed: a1");
    expect(seen.has("entry-1")).toBe(true);
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
    // Reset and inject a new entry for the live path.
    const newEntry = makeCustomMessageEntry(
      "subagent-notify",
      true,
      { status: "paused", agent: "live-agent" },
      "",
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
    expect(send).toHaveBeenCalledWith("⏸ Background task paused: live-agent");
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
