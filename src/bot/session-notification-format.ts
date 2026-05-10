import type { CustomMessageEntry } from "@mariozechner/pi-coding-agent";

const MAX_NOTIFICATION_TEXT_LENGTH = 700;

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

export function sanitizeNotificationText(text: string): string {
  return text
    .replace(/file:\/\/[^\s\)\"'>\]]+/g, "")
    .replace(/\/(home|Users|tmp|workspace|var|usr|private|opt|Applications|System)\/[^\s\)\"',;\n<>]*/g, "[local path]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function truncateNotificationText(text: string): string {
  return text.length > MAX_NOTIFICATION_TEXT_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_TEXT_LENGTH - 1)}…`
    : text;
}

function stripMarkdownEmphasis(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").trim();
}

function sanitizeHeaderFragment(fragment: string | undefined): string | undefined {
  if (!fragment) {
    return undefined;
  }

  const sanitized = sanitizeNotificationText(fragment);
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

  const explicitSummary = summaryLines
    .find((line) => /^Summary:\s*/i.test(line))
    ?.replace(/^Summary:\s*/i, "")
    .trim();

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

  const substantiveLines = summaryLines
    .filter((line) => !/^[A-Za-z0-9_.-]+:$/.test(line))
    .filter((line) => !/^Summary:\s*/i.test(line));
  let body = sanitizeNotificationText(explicitSummary ?? substantiveLines.join("\n"));

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
