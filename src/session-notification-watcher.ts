import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, watchFile, unwatchFile } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentSession, CustomMessageEntry, SessionEntry } from "@mariozechner/pi-coding-agent";

import { formatNotification, sanitizeNotificationText } from "./bot/session-notification-format.js";

export { formatNotification, sanitizeNotificationText };

type TailBuffer = Buffer<ArrayBufferLike>;

const MAX_SUMMARY_OUTPUT_BYTES = 128 * 1024;

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

function getSessionFile(session: AgentSession): string | undefined {
  const sessionFile = (session as AgentSession & { sessionFile?: unknown }).sessionFile;
  return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : undefined;
}

function splitCompleteLines(buffer: TailBuffer): { lines: string[]; remainder: TailBuffer } {
  const lines: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) {
      continue;
    }

    const line = buffer.subarray(start, i).toString("utf8").trim();
    if (line) {
      lines.push(line);
    }
    start = i + 1;
  }

  return {
    lines,
    remainder: start < buffer.length ? (Buffer.from(buffer.subarray(start)) as TailBuffer) : (Buffer.alloc(0) as TailBuffer),
  };
}

function readAppendedEntries(
  sessionFile: string,
  start: number,
  end: number,
  tailBytes: TailBuffer,
): { entries: SessionEntry[]; remainder: TailBuffer } {
  const length = Math.max(0, end - start);
  const readBytes = (length > 0 ? Buffer.alloc(length) : Buffer.alloc(0)) as TailBuffer;

  if (length > 0) {
    const fd = openSync(sessionFile, "r");
    try {
      readSync(fd, readBytes, 0, length, start);
    } finally {
      closeSync(fd);
    }
  }

  const combined = tailBytes.length > 0 ? Buffer.concat([tailBytes, readBytes]) : readBytes;
  const { lines, remainder } = splitCompleteLines(combined);
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as SessionEntry];
    } catch (error) {
      console.error("Failed to parse appended session notification entry:", error);
      return [];
    }
  });

  return { entries, remainder };
}

function extractSessionFileFromContent(content: string): string | undefined {
  const match = content.match(/^Session file:\s*(.+)$/im);
  return match?.[1]?.trim();
}

function extractOutputFilesFromContent(content: string): string[] {
  return [...content.matchAll(/^Output saved to:\s*(.+?)\s*\([^\n]+\)\./gim)]
    .map((match) => match[1]?.trim())
    .filter((file): file is string => Boolean(file));
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? normalized).trim();
}

function getAsyncRunBaseDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return path.join(tmpdir(), uid === undefined ? "pi-subagents" : `pi-subagents-uid-${uid}`, "async-subagent-runs");
}

function isInsidePath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function getOutputSummaryAllowedRoots(): string[] {
  const roots = [getAsyncRunBaseDir(), path.join(process.cwd(), "reviews")];
  return roots.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
}

function readSafeSummaryOutput(file: string, allowedRoots: string[]): string | undefined {
  try {
    if (!existsSync(file)) {
      return undefined;
    }

    const realFile = realpathSync(file);
    if (!allowedRoots.some((root) => isInsidePath(realFile, root))) {
      return undefined;
    }

    const stat = statSync(realFile);
    if (!stat.isFile() || stat.size > MAX_SUMMARY_OUTPUT_BYTES) {
      return undefined;
    }

    return readFileSync(realFile, "utf8");
  } catch {
    return undefined;
  }
}

function sanitizeOutputSummary(summary: string): string {
  return sanitizeNotificationText(summary)
    .replace(/(?:file:\/\/)?\/(?:Users|private|tmp|var|Volumes)\/\S+/g, "[local path]")
    .replace(/~\/\S+/g, "[local path]")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeReferencedOutputs(files: string[]): string | undefined {
  const allowedRoots = getOutputSummaryAllowedRoots();
  if (allowedRoots.length === 0) {
    return undefined;
  }

  const contents = files.flatMap((file) => {
    const content = readSafeSummaryOutput(file, allowedRoots);
    return content === undefined ? [] : [content];
  });

  if (contents.length === 0) {
    return undefined;
  }

  const blockerLines = contents.flatMap((content) =>
    content.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s*Blocker:/i.test(line) || /^Blocker:/i.test(line))
      .map((line) => line.replace(/^[-*]\s*/, "").replace(/^Blocker:\s*/i, "")),
  );

  if (blockerLines.length > 0) {
    return sanitizeOutputSummary(`One blocker remains: ${firstSentence(blockerLines[0])} Everything else reviewed well.`);
  }

  const failedLines = contents.flatMap((content) =>
    content.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s*(?:Failed|Failure|Error):/i.test(line))
      .map((line) => line.replace(/^[-*]\s*/, "")),
  );

  if (failedLines.length > 0) {
    return sanitizeOutputSummary(`One issue needs attention: ${firstSentence(failedLines[0].replace(/^[^:]+:\s*/, ""))}`);
  }

  const noteLines = contents.flatMap((content) =>
    content.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s*Note:/i.test(line))
      .map((line) => line.replace(/^[-*]\s*/, "").replace(/^Note:\s*/i, "")),
  );

  if (noteLines.length > 0) {
    return sanitizeOutputSummary(`No blockers found. Note: ${firstSentence(noteLines[0])}`);
  }

  return "No blockers found in the returned reviews.";
}

function findAsyncStatusForSession(sessionFile: string): { error?: string; state?: string } | undefined {
  const baseDir = getAsyncRunBaseDir();
  if (!existsSync(baseDir)) {
    return undefined;
  }

  const statusPaths = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, "status.json"))
    .filter((statusPath) => existsSync(statusPath))
    .sort((left, right) => {
      try {
        return statSync(right).mtimeMs - statSync(left).mtimeMs;
      } catch {
        return 0;
      }
    });

  for (const statusPath of statusPaths) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8")) as {
        state?: string;
        error?: string;
        sessionFile?: string;
        steps?: Array<{ sessionFile?: string; error?: string; status?: string; modelAttempts?: Array<{ error?: string }> }>;
      };
      const matchingStep = status.steps?.find((step) => step.sessionFile === sessionFile);
      if (status.sessionFile !== sessionFile && !matchingStep) {
        continue;
      }
      return {
        state: matchingStep?.status ?? status.state,
        error: matchingStep?.error ?? matchingStep?.modelAttempts?.find((attempt) => attempt.error)?.error ?? status.error,
      };
    } catch {
      // Ignore stale or partially written status files.
    }
  }

  return undefined;
}

function summarizeRuntimeIssue(error: string | undefined): string | undefined {
  if (!error) {
    return undefined;
  }

  if (/server_error|server error/i.test(error)) {
    return "Runtime issue: agent server error while finalizing.";
  }
  if (/websocket/i.test(error)) {
    return "Runtime issue: connection error while finalizing.";
  }
  if (/codex error/i.test(error)) {
    return "Runtime issue: agent runtime error while finalizing.";
  }

  return "Runtime issue: agent stopped while finalizing.";
}

function enrichNotificationEntry(entry: CustomMessageEntry): CustomMessageEntry {
  if (entry.customType !== "subagent-notify" || typeof entry.content !== "string") {
    return entry;
  }

  const childSessionFile = extractSessionFileFromContent(entry.content);
  if (!childSessionFile) {
    return entry;
  }

  const additions: string[] = [];
  const outputSummary = summarizeReferencedOutputs(extractOutputFilesFromContent(entry.content));
  if (outputSummary && !entry.content.includes(outputSummary)) {
    additions.push(`Summary: ${outputSummary}`);
  }

  const runtimeIssue = summarizeRuntimeIssue(findAsyncStatusForSession(childSessionFile)?.error);
  if (runtimeIssue && !entry.content.includes(runtimeIssue)) {
    additions.push(runtimeIssue);
  }

  if (additions.length === 0) {
    return entry;
  }

  return {
    ...entry,
    content: `${entry.content.trim()}\n\n${additions.join("\n")}`,
  };
}

/**
 * Attempt to deliver a single notification entry.
 *
 * `markSeen` is called only after `send` resolves successfully. If delivery
 * fails the entry is intentionally left un-marked so the next catch-up,
 * retry timer, or live-event pass can retry it. Any error is logged but not
 * re-thrown — delivery is best-effort and must not crash the caller.
 */
function tryDeliverEntry(
  entry: CustomMessageEntry,
  isAlreadySeen: (id: string) => boolean,
  markSeen: (id: string) => void,
  send: NotificationSend,
  inFlight: Set<string>,
  retry?: () => void,
): void {
  if (isAlreadySeen(entry.id) || inFlight.has(entry.id)) {
    return;
  }

  const enrichedEntry = enrichNotificationEntry(entry);
  const text = formatNotification(enrichedEntry);
  if (!text) {
    markSeen(entry.id);
    return;
  }

  inFlight.add(entry.id);
  void send(text)
    .then(
      () => markSeen(entry.id),
      (error) => {
        console.error("Failed to send session notification:", error);
        retry?.();
      },
    )
    .finally(() => {
      inFlight.delete(entry.id);
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
  sharedInFlight: Set<string> = new Set<string>(),
): () => void {
  const inFlight = sharedInFlight;
  const sessionFile = getSessionFile(session);
  let fileOffset = 0;
  let tailBytes: TailBuffer = Buffer.alloc(0) as TailBuffer;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const scheduleRetry = (): void => {
    if (disposed || retryTimer !== undefined) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (disposed) {
        return;
      }
      for (const entry of session.sessionManager.getEntries()) {
        if (isActionableCustomMessageEntry(entry)) {
          tryDeliverEntry(entry, isAlreadySeen, markSeen, send, inFlight, scheduleRetry);
        }
      }
    }, 5000);
  };

  const initialFileSize = sessionFile
    ? (() => {
        try {
          return statSync(sessionFile).size;
        } catch {
          return 0;
        }
      })()
    : 0;

  // Catch-up: deliver any actionable notifications already in the session.
  for (const entry of session.sessionManager.getEntries()) {
    if (isActionableCustomMessageEntry(entry)) {
      tryDeliverEntry(entry, isAlreadySeen, markSeen, send, inFlight, scheduleRetry);
    }
  }

  fileOffset = initialFileSize;

  const drainFile = sessionFile
    ? () => {
        try {
          const currentSize = statSync(sessionFile).size;
          if (currentSize < fileOffset) {
            fileOffset = 0;
            tailBytes = Buffer.alloc(0) as TailBuffer;
          }

          const { entries, remainder } = readAppendedEntries(sessionFile, fileOffset, currentSize, tailBytes);
          fileOffset = currentSize;
          tailBytes = remainder;

          for (const entry of entries) {
            if (isActionableCustomMessageEntry(entry)) {
              tryDeliverEntry(entry, isAlreadySeen, markSeen, send, inFlight, scheduleRetry);
            }
          }
        } catch (error) {
          console.error("Failed to read appended session notifications:", error);
        }
      }
    : undefined;

  if (sessionFile && drainFile) {
    watchFile(sessionFile, { interval: 1000 }, drainFile);
    drainFile();
  }

  // Live watch: deliver future actionable custom messages emitted in this process.
  const unsubscribeSession = session.subscribe((event) => {
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

    const entries = session.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom_message" && (entry as CustomMessageEntry).customType === message.customType) {
        if (isActionableCustomMessageEntry(entry)) {
          tryDeliverEntry(entry, isAlreadySeen, markSeen, send, inFlight, scheduleRetry);
        }
        return;
      }
    }

    if (drainFile) {
      drainFile();
      return;
    }

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
    tryDeliverEntry(syntheticEntry, isAlreadySeen, markSeen, send, inFlight, scheduleRetry);
  });

  return () => {
    disposed = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    unsubscribeSession();
    if (sessionFile && drainFile) {
      unwatchFile(sessionFile, drainFile);
    }
  };
}
