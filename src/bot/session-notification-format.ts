import type { CustomMessageEntry } from "@mariozechner/pi-coding-agent";

const MAX_NOTIFICATION_TEXT_LENGTH = 700;
const MAX_SUMMARY_ITEMS = 3;
const MAX_SUMMARY_ITEM_LENGTH = 220;

export interface SessionNotificationFormatResult {
  header: string;
  summary?: string;
  status?: "completed" | "failed" | "paused" | "partial";
  agent?: string;
}

function getStringDetail(details: unknown, ...keys: string[]): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const obj = details as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function normalizeNotificationWhitespace(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ {2,}/g, " ").trim());

  const collapsed: string[] = [];
  let previousWasBlank = false;

  for (const line of lines) {
    if (!line) {
      if (collapsed.length === 0 || previousWasBlank) {
        continue;
      }
      collapsed.push("");
      previousWasBlank = true;
      continue;
    }

    collapsed.push(line);
    previousWasBlank = false;
  }

  while (collapsed.at(-1) === "") {
    collapsed.pop();
  }

  return collapsed.join("\n").trim();
}

export function sanitizeNotificationText(text: string): string {
  return normalizeNotificationWhitespace(
    text
      .replace(/file:\/\/[^\s\)\"'>\]]+/g, "")
      .replace(/\/(home|Users|tmp|workspace|var|usr|private|opt|Applications|System)\/[^\s\)\"',;\n<>]*/g, "[local path]"),
  );
}

function truncateNotificationText(text: string): string {
  return text.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH - 1)}…`
    : text;
}

function stripMarkdownEmphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function sanitizeHeaderFragment(fragment: string | undefined): string | undefined {
  if (!fragment) {
    return undefined;
  }

  const sanitized = sanitizeNotificationText(fragment).replace(/\s+/g, " ").trim();
  return sanitized || undefined;
}

function pluralizeAgentLabel(label: string, count: number): string {
  if (count === 1) {
    return label;
  }

  if (label.endsWith("s")) {
    return label;
  }

  return `${label}s`;
}

function humanizeParallelAgent(agent: string | undefined): string | undefined {
  if (!agent?.startsWith("parallel:")) {
    return agent;
  }

  const labels = agent.slice("parallel:".length).split("+").map((label) => label.trim()).filter(Boolean);
  if (labels.length === 0) {
    return agent;
  }

  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length === 1) {
    return `${labels.length} ${pluralizeAgentLabel(uniqueLabels[0], labels.length)}`;
  }

  return `${labels.length} tasks`;
}

function hasExplicitValidationSuccess(lines: string[]): boolean {
  return lines.some((line) => {
    const normalized = stripMarkdownEmphasis(line).toLowerCase();

    if (/\b(?:not\s+passed|did\s+not\s+pass|failed|failure|not\s+successful)\b/.test(normalized)) {
      return false;
    }

    return (
      /\bvalidation\b.*\b(passed|succeeded|successful)\b/.test(normalized) ||
      /\bchecks?\b.*\b(passed|succeeded|successful)\b/.test(normalized) ||
      /\btests?\b.*\b(passed|succeeded|successful)\b/.test(normalized)
    );
  });
}

function isStandaloneSectionHeading(line: string): boolean {
  return /^(summary|findings?|details?|notes?|status|validation|checks?|outcome|review|results?|next steps?)[:]?$/.test(
    line.trim().toLowerCase(),
  );
}

function stripMarkdownLinePrefix(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function truncateSummaryItem(text: string): string {
  if (text.length <= MAX_SUMMARY_ITEM_LENGTH) {
    return text;
  }

  const sentenceMatch = text.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1] && sentenceMatch[1].length <= MAX_SUMMARY_ITEM_LENGTH) {
    return sentenceMatch[1];
  }

  return `${text.slice(0, MAX_SUMMARY_ITEM_LENGTH - 1).trimEnd()}…`;
}

function extractSummaryItem(line: string): string | undefined {
  const withoutEmphasis = stripMarkdownEmphasis(line);
  const withoutPrefix = stripMarkdownLinePrefix(withoutEmphasis);
  const withoutLabel = withoutPrefix.replace(/^Summary:\s*/i, "").trim();
  const sanitized = sanitizeNotificationText(withoutLabel).replace(/\s+/g, " ").trim();

  if (!sanitized) {
    return undefined;
  }

  if (/^[A-Za-z0-9_.-]+:$/.test(sanitized)) {
    return undefined;
  }

  if (isStandaloneSectionHeading(sanitized)) {
    return undefined;
  }

  return truncateSummaryItem(sanitized);
}

function renderSummaryItems(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0];
  }

  return items.map((item) => `• ${item}`).join("\n");
}

function buildConciseSummary(lines: string[]): string {
  const meaningfulLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !isStandaloneSectionHeading(stripMarkdownLinePrefix(stripMarkdownEmphasis(trimmed)));
  });

  if (meaningfulLines.length === 1) {
    const single = meaningfulLines[0]
      .replace(/^Summary:\s*/i, "")
      .trim();
    return sanitizeNotificationText(stripMarkdownLinePrefix(stripMarkdownEmphasis(single)));
  }

  const items: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const item = extractSummaryItem(line);
    if (!item) {
      continue;
    }

    const key = item.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    items.push(item);
    seen.add(key);

    if (items.length >= MAX_SUMMARY_ITEMS) {
      break;
    }
  }

  return renderSummaryItems(items);
}

function summarizeSubagentContent(rawContent: string): {
  status?: "completed" | "failed" | "paused" | "partial";
  agent?: string;
  body: string;
} {
  const lines = rawContent.split(/\r?\n/).map((line) => stripMarkdownEmphasis(line.trim()));
  const firstLine = lines.find(Boolean) ?? "";
  const match = firstLine.match(/^Background task (completed|failed|paused):\s*(.+)$/i);
  const status = match?.[1]?.toLowerCase() as "completed" | "failed" | "paused" | undefined;
  const rawAgent = match?.[2]?.trim();
  const agent = humanizeParallelAgent(rawAgent);

  const summaryLines = lines
    .slice(match ? 1 : 0)
    .filter(Boolean)
    .filter((line) => !/^Output saved to:/i.test(line))
    .filter((line) => !/^Session file:/i.test(line))
    .filter((line) => !/^Read this file if needed\.?$/i.test(line));

  const agentLabels = summaryLines
    .filter((line) => /^[A-Za-z0-9_.-]+:$/.test(line))
    .map((line) => line.slice(0, -1));

  const outputSavedCount = lines.filter((line) => /^Output saved to:/i.test(line)).length;
  const wroteReviewCount = lines.filter((line) => /^Wrote .+ to `/i.test(line)).length;
  const returnedCount = outputSavedCount + wroteReviewCount;
  const validationPassed = hasExplicitValidationSuccess(lines);

  const hasUsefulWork = lines.some((line) => /\b(implemented|changed files?|validation:)\b/i.test(line));
  const hasRuntimeIssue = lines.some((line) => /\b(runtime issue|server error|websocket error|codex error)\b/i.test(line));

  if (status === "failed" && hasUsefulWork && validationPassed && hasRuntimeIssue) {
    return {
      status: "partial",
      agent,
      body: "Work finished and validation passed. The run was marked failed because the agent hit a runtime issue while finalizing.",
    };
  }

  if (status === "failed" && rawAgent?.startsWith("parallel:") && agentLabels.length > 1) {
    const count = returnedCount || agentLabels.length;
    const uniqueLabels = [...new Set(agentLabels)];
    const label = uniqueLabels.length === 1 ? pluralizeAgentLabel(uniqueLabels[0], count) : "tasks";
    const checks = validationPassed ? " Focused checks passed." : "";
    return {
      status: "partial",
      agent,
      body: `${count} ${label} returned notes.${checks} One part still needs a quick look.`,
    };
  }

  let body = buildConciseSummary(summaryLines);

  if (!body && status === "completed" && agentLabels.length > 0) {
    const uniqueLabels = [...new Set(agentLabels)];
    const label = uniqueLabels.length === 1 ? pluralizeAgentLabel(uniqueLabels[0], agentLabels.length) : "tasks";
    body = `${agentLabels.length} ${label} completed successfully.`;
  }

  return { status, agent, body };
}

function buildSummary(rawContent: string, details: unknown): SessionNotificationFormatResult {
  const contentSummary = summarizeSubagentContent(rawContent);
  const agent = sanitizeHeaderFragment(
    getStringDetail(details, "agent", "agentName", "name") ?? contentSummary.agent,
  );
  const detailStatus = getStringDetail(details, "status", "state");
  const status = contentSummary.status === "partial" ? "partial" : detailStatus ?? contentSummary.status;
  const notice = getStringDetail(details, "notice", "message", "summary");
  const suffix = agent ? `: ${agent}` : "";

  if (status === "completed" || status === "done" || status === "success") {
    return {
      header: `✅ Background task completed${suffix}`,
      summary: contentSummary.body || undefined,
      status: "completed",
      agent,
    };
  }

  if (status === "failed" || status === "error") {
    return {
      header: `❌ Background task failed${suffix}`,
      summary: contentSummary.body || undefined,
      status: "failed",
      agent,
    };
  }

  if (status === "paused") {
    return {
      header: `⏸ Background task paused${suffix}`,
      summary: contentSummary.body || undefined,
      status: "paused",
      agent,
    };
  }

  if (status === "partial") {
    return {
      header: `⚠️ Background task partly completed${suffix}`,
      summary: contentSummary.body || undefined,
      status: "partial",
      agent,
    };
  }

  const rawText = sanitizeNotificationText(rawContent);
  const fallbackSource = (notice ?? contentSummary.body) || rawText;
  const fallbackText = sanitizeNotificationText(fallbackSource);

  return {
    header: `🔔 Subagent notification${suffix}`,
    summary: fallbackText || undefined,
    agent,
  };
}

function buildControlNotice(rawContent: string, details: unknown): SessionNotificationFormatResult {
  const agent = sanitizeHeaderFragment(getStringDetail(details, "agent", "agentName", "name"));
  const event = getStringDetail(details, "event", "eventType");
  const notice = getStringDetail(details, "notice", "message", "summary");
  const contentSummary = summarizeSubagentContent(rawContent);
  const suffix = agent ? `: ${agent}` : "";

  if (event?.includes("needs_attention") || event?.includes("needsAttention")) {
    return {
      header: `⚠️ Subagent needs attention${suffix}`,
      summary: contentSummary.body || undefined,
      agent,
    };
  }

  const fallbackSource = (notice ?? contentSummary.body) || rawContent;
  const fallbackText = sanitizeNotificationText(fallbackSource);
  return {
    header: `⚠️ Subagent notice${suffix}`,
    summary: fallbackText || undefined,
    agent,
  };
}

export function buildSessionNotification(entry: CustomMessageEntry): SessionNotificationFormatResult {
  const rawContent = typeof entry.content === "string" ? entry.content.trim() : "";

  if (entry.customType === "subagent-notify") {
    return buildSummary(rawContent, entry.details);
  }

  if (entry.customType === "subagent_control_notice") {
    return buildControlNotice(rawContent, entry.details);
  }

  return { header: "" };
}

export function formatNotification(entry: CustomMessageEntry): string {
  const { header, summary } = buildSessionNotification(entry);
  if (!header) {
    return "";
  }

  if (!summary) {
    return header;
  }

  return `${header}\n${truncateNotificationText(summary)}`;
}
