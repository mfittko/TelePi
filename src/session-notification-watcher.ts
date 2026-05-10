import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { CustomMessageEntry, SessionEntry } from "@mariozechner/pi-coding-agent";

/**
 * Maximum character length for the text portion of a notification body.
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

export type NotificationSend = (text: string) => Promise<void>;

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
 * Strip content that is not actionable from a remote Telegram client.
 *
 * Removes:
 * - `file://` URIs (local file references)
 * - Absolute local paths (e.g. /home/user/…, /Users/name/…, /tmp/…)
 *
 * Relative paths such as `src/main.ts` are kept as they are descriptive.
 */
export function sanitizeNotificationText(text: string): string {
  return text
    // Remove file:// URIs
    .replace(/file:\/\/[^\s\)\"'>\]]+/g, "")
    // Replace common absolute local paths with a placeholder
    .replace(/\/(home|Users|tmp|workspace|var|usr|private|opt|Applications|System)\/[^\s\)\"\',;\n<>]*/g, "[local path]")
    .replace(/\s{2,}/g, " ")
    .trim();
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

/**
 * Append the LLM-generated content body (the Pi display text) to a header line.
 *
 * The body is sanitized to remove local-only paths before delivery and is
 * truncated to MAX_NOTIFICATION_TEXT_LENGTH characters if necessary.
 */
function appendBody(header: string, entry: CustomMessageEntry): string {
  const rawBody = typeof entry.content === "string" ? entry.content.trim() : "";
  const body = sanitizeNotificationText(rawBody);
  if (!body) {
    return header;
  }
  const truncated = body.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${body.slice(0, MAX_NOTIFICATION_TEXT_LENGTH)}…`
    : body;
  return `${header}\n${truncated}`;
}

function formatSubagentNotify(entry: CustomMessageEntry): string {
  const agent = getStringDetail(entry.details, "agent", "agentName", "name");
  const status = getStringDetail(entry.details, "status", "state");
  const suffix = agent ? `: ${agent}` : "";

  if (status === "completed" || status === "done" || status === "success") {
    return appendBody(`✅ Background task completed${suffix}`, entry);
  }
  if (status === "failed" || status === "error") {
    return appendBody(`❌ Background task failed${suffix}`, entry);
  }
  if (status === "paused") {
    return appendBody(`⏸ Background task paused${suffix}`, entry);
  }

  // Unknown status — use the sanitized content/notice as an inline body.
  const notice = getStringDetail(entry.details, "notice", "message", "summary");
  const rawText = typeof entry.content === "string" ? entry.content.trim() : "";
  const text = sanitizeNotificationText(notice ?? rawText);
  if (!text) {
    return `🔔 Subagent notification${suffix}`;
  }
  const truncated = text.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH)}…`
    : text;
  return `🔔 Subagent notification${suffix}: ${truncated}`;
}

function formatControlNotice(entry: CustomMessageEntry): string {
  const agent = getStringDetail(entry.details, "agent", "agentName", "name");
  const event = getStringDetail(entry.details, "event", "eventType");
  const suffix = agent ? `: ${agent}` : "";

  if (event?.includes("needs_attention") || event?.includes("needsAttention")) {
    return appendBody(`⚠️ Subagent needs attention${suffix}`, entry);
  }

  // For other control notices, use content/notice as an inline body.
  const notice = getStringDetail(entry.details, "notice", "message", "summary");
  const rawText = typeof entry.content === "string" ? entry.content.trim() : "";
  const text = sanitizeNotificationText(notice ?? rawText);
  if (!text) {
    return `⚠️ Subagent notice${suffix}`;
  }
  const truncated = text.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH)}…`
    : text;
  return `⚠️ Subagent notice${suffix}: ${truncated}`;
}

/**
 * Attempt to deliver a single notification entry.
 *
 * `markSeen` is called only after `send` resolves successfully. If delivery
 * fails the entry is intentionally left un-marked so the next catch-up or
 * live-event pass can retry it. Any error is logged but not re-thrown —
 * delivery is best-effort and must not crash the caller.
 */
function tryDeliverEntry(
  entry: CustomMessageEntry,
  isAlreadySeen: (id: string) => boolean,
  markSeen: (id: string) => void,
  send: NotificationSend,
): void {
  if (isAlreadySeen(entry.id)) {
    return;
  }
  const text = formatNotification(entry);
  if (!text) {
    // No notification text — mark as seen to avoid repeated attempts.
    markSeen(entry.id);
    return;
  }
  void send(text).then(
    () => markSeen(entry.id),
    (error) => {
      console.error("Failed to send session notification:", error);
    },
  );
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
