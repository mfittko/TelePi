import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { CustomMessageEntry, SessionEntry } from "@mariozechner/pi-coding-agent";

/**
 * Maximum character length for the text portion of a notification message.
 */
const MAX_NOTIFICATION_TEXT_LENGTH = 200;

/**
 * Custom message types that are forwarded as Telegram notifications.
 * Only whitelisted types are sent — ordinary assistant/user/tool messages are never forwarded.
 */
export const ACTIONABLE_CUSTOM_TYPES = new Set([
  "subagent-notify",
  "subagent_control_notice",
]);

export type NotificationSend = (text: string) => void | Promise<void>;

/**
 * Returns true if the session entry is an actionable custom message
 * that should be forwarded as a Telegram notification.
 */
export function isActionableCustomMessageEntry(entry: SessionEntry): entry is CustomMessageEntry {
  return (
    entry.type === "custom_message" &&
    (entry as CustomMessageEntry).display === true &&
    ACTIONABLE_CUSTOM_TYPES.has((entry as CustomMessageEntry).customType)
  );
}

/**
 * Format a concise Telegram notification text for a custom message entry.
 * Returns an empty string for unknown/unformattable entries.
 */
export function formatNotification(entry: CustomMessageEntry): string {
  if (entry.customType === "subagent-notify") {
    return formatSubagentNotify(entry);
  }
  if (entry.customType === "subagent_control_notice") {
    return formatControlNotice(entry);
  }
  return "";
}

function getStringDetail(details: unknown, ...keys: string[]): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const obj = details as Record<string, unknown>;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return undefined;
}

function formatSubagentNotify(entry: CustomMessageEntry): string {
  const agent = getStringDetail(entry.details, "agent", "agentName", "name");
  const status = getStringDetail(entry.details, "status", "state");
  const notice = getStringDetail(entry.details, "notice", "message", "summary");
  const suffix = agent ? `: ${agent}` : "";

  if (status === "completed" || status === "done" || status === "success") {
    return `✅ Background task completed${suffix}`;
  }
  if (status === "failed" || status === "error") {
    return `❌ Background task failed${suffix}`;
  }
  if (status === "paused") {
    return `⏸ Background task paused${suffix}`;
  }

  const text = notice ?? (typeof entry.content === "string" ? entry.content.trim() : "");
  if (!text) {
    return `🔔 Subagent notification${suffix}`;
  }
  const truncated = text.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH)}…`
    : text;
  return `🔔 Subagent notification${suffix}: ${truncated}`;
}

function formatControlNotice(entry: CustomMessageEntry): string {
  const agent = getStringDetail(entry.details, "agent", "agentName", "name", "run");
  const event = getStringDetail(entry.details, "event", "eventType");
  const notice = getStringDetail(entry.details, "notice", "message", "summary");
  const suffix = agent ? `: ${agent}` : "";

  if (event?.includes("needs_attention") || event?.includes("needsAttention")) {
    return `⚠️ Subagent needs attention${suffix}`;
  }

  const text = notice ?? (typeof entry.content === "string" ? entry.content.trim() : "");
  if (!text) {
    return `⚠️ Subagent notice${suffix}`;
  }
  const truncated = text.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH)}…`
    : text;
  return `⚠️ Subagent notice${suffix}: ${truncated}`;
}

function tryDeliverEntry(
  entry: CustomMessageEntry,
  isAlreadySeen: (id: string) => boolean,
  markSeen: (id: string) => void,
  send: NotificationSend,
): void {
  if (isAlreadySeen(entry.id)) {
    return;
  }
  markSeen(entry.id);
  const text = formatNotification(entry);
  if (!text) {
    return;
  }
  void Promise.resolve(send(text)).catch((error) => {
    console.error("Failed to send session notification:", error);
  });
}

/**
 * Attach a long-lived notification watcher to a Pi session.
 *
 * 1. Performs catch-up: scans existing session entries and sends notifications
 *    for any actionable custom messages not yet delivered (covers missed
 *    notifications while TelePi was offline or restarting).
 * 2. Subscribes to live session events: delivers future actionable custom
 *    messages as they arrive.
 *
 * Returns an unsubscribe function. Call it to detach the watcher (e.g. on
 * session replacement, handback, or service disposal).
 */
export function createSessionNotificationWatcher(
  session: AgentSession,
  isAlreadySeen: (id: string) => boolean,
  markSeen: (id: string) => void,
  send: NotificationSend,
): () => void {
  // Catch-up: deliver any actionable notifications already in the session.
  for (const entry of session.sessionManager.getEntries()) {
    if (isActionableCustomMessageEntry(entry)) {
      tryDeliverEntry(entry, isAlreadySeen, markSeen, send);
    }
  }

  // Live watch: deliver future actionable custom messages.
  return session.subscribe((event) => {
    if (event.type !== "message_end") {
      return;
    }

    const message = event.message as {
      role?: string;
      customType?: string;
      display?: boolean;
      timestamp?: number;
      content?: unknown;
      details?: unknown;
    };

    if (message.role !== "custom" || !message.display) {
      return;
    }

    if (!message.customType || !ACTIONABLE_CUSTOM_TYPES.has(message.customType)) {
      return;
    }

    // Find the corresponding entry in the session manager for a stable ID.
    // The newest matching entry is at the end of getEntries().
    const entries = session.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom_message" && (entry as CustomMessageEntry).customType === message.customType) {
        tryDeliverEntry(entry as CustomMessageEntry, isAlreadySeen, markSeen, send);
        return;
      }
    }

    // Fallback: build a synthetic entry when the session entry is not found.
    const fallbackId = `${message.customType}::${message.timestamp ?? Date.now()}`;
    const syntheticEntry: CustomMessageEntry = {
      type: "custom_message",
      id: fallbackId,
      parentId: null,
      timestamp: new Date(message.timestamp ?? Date.now()).toISOString(),
      customType: message.customType,
      content: typeof message.content === "string" ? message.content : "",
      display: true,
      details: message.details,
    };
    tryDeliverEntry(syntheticEntry, isAlreadySeen, markSeen, send);
  });
}
