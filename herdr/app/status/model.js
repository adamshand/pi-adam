/* oxlint-disable anti-slop/no-runtime-typeof -- Native core-label JSON is an untrusted I/O boundary; GPUI cannot import npm schema libraries. */
export const FOOTER_LABEL = "pi-adam.footer";
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const text = (value) => typeof value === "string" && value.length > 0 && value.length <= 256
  && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);

/** Exact focused address only, including remote machine prefix and terminal replacements. */
export function focusedMetrics(focus, terminals) {
  const address = focus?.shown || focus?.terminal;
  if (!address) return null;
  const terminal = terminals.find(item => item.address === address);
  if (!terminal || terminal.state !== "live" || terminal.report?.app !== "pi") return null;
  try {
    const data = JSON.parse(terminal.labels?.[FOOTER_LABEL] ?? "null");
    if (!data || data.version !== 1 || !text(data.owner) || !text(data.session_id)
      || !text(data.model) || !text(data.thinking) || ![null, "on", "off"].includes(data.fast)
      || !finite(data.cost) || !finite(data.contextTokens) || !finite(data.contextWindow)
      || (data.speed !== undefined && !finite(data.speed))) return null;
    const git = data.git;
    if (git !== undefined && (!git || ![git.added, git.removed].every(Number.isSafeInteger)
      || !finite(git.added) || !finite(git.removed)
      || [git.ahead, git.behind].some(value => value !== undefined && (!finite(value) || !Number.isSafeInteger(value))))) return null;
    const usage = data.usage;
    if (usage !== undefined && (!usage || !["idle", "loading", "ready", "stale", "error", "ineligible"].includes(usage.status)
      || [usage.fiveHourUsed, usage.weeklyUsed, usage.availableResets, usage.fiveHourResetAt, usage.weeklyResetAt].some(value => value !== undefined && !finite(value))
      || (usage.resetExpirations !== undefined && (!Array.isArray(usage.resetExpirations) || usage.resetExpirations.length > 64
        || usage.resetExpirations.some(value => value !== null && !finite(value)))))) return null;
    const controls = data.controls;
    if (controls !== undefined && (!controls || !text(controls.socket) || !text(controls.owner)
      || !text(controls.node) || !text(controls.client) || controls.session !== data.session_id
      || typeof controls.idle !== "boolean" || !Array.isArray(controls.actions)
      || controls.actions.some(action => !["model", "thinking", "fast"].includes(action)))) return null;
    return data;
  } catch { return null; }
}

function resetTime(epoch, now) {
  if (epoch === undefined || !Number.isFinite(new Date(epoch * 1000).getTime())) return "Not reported";
  const minutes = Math.ceil((epoch * 1000 - now) / 60000);
  const remaining = minutes <= 0 ? "time passed; awaiting updated usage"
    : minutes >= 1440 ? `in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
    : minutes >= 60 ? `in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `in ${minutes}m`;
  return `${new Date(epoch * 1000).toLocaleString()} (local time; ${remaining})`;
}

function usageHealth(usage) {
  return usage.status === "loading" ? "Refreshing in background; showing last known usage."
    : usage.status === "stale" ? "Usage is stale; showing last known values."
    : usage.status === "error" ? "Usage could not be refreshed." : "";
}

export function resetCreditTooltip(usage, now = Date.now()) {
  const count = usage.availableResets;
  const lines = [count === undefined ? "Banked reset count not reported." : `${count} banked reset${count === 1 ? "" : "s"}`];
  if (count === 0) return lines.join("\n");
  const expirations = usage.resetExpirations ?? [];
  for (const [index, epoch] of expirations.entries()) {
    lines.push(`Reset ${index + 1}: ${epoch === null ? "Does not expire" : "expires " + resetTime(epoch, now)}`);
  }
  if (!expirations.length) lines.push("Expiry details not reported.");
  else if (count === undefined || expirations.length < count) lines.push("Expiry details may be partial; the banked count is authoritative.");
  return lines.join("\n");
}

/** Supplemental detail rather than a duplicate of the visible metrics. */
export function footerTooltip(data, now = Date.now()) {
  const usage = data?.usage;
  if (!usage) return "Quota reset information is not available yet.";
  return [
    `5-hour quota resets: ${resetTime(usage.fiveHourResetAt, now)}`,
    `Weekly quota resets: ${resetTime(usage.weeklyResetAt, now)}`,
    usage.availableResets !== undefined || usage.resetExpirations !== undefined ? resetCreditTooltip(usage, now) : "",
    usageHealth(usage),
  ].filter(Boolean).join("\n");
}

export function metricParts(data, now = Date.now()) {
  const parts = [];
  const git = data.git;
  if (git) {
    for (const [key, prefix, tone, meaning] of [
      ["added", "+", "done", "Lines added (staged + unstaged tracked changes vs HEAD)"],
      ["removed", "−", "blocked", "Lines removed (staged + unstaged tracked changes vs HEAD)"],
      ["ahead", "↑", "done", "Commits ahead of the configured upstream (last fetched)"],
      ["behind", "↓", "working", "Commits behind the configured upstream (last fetched)"],
    ]) {
      if (git[key]) parts.push({ text: `${prefix}${git[key]}`, tone, kind: "git", tooltip: meaning });
    }
  }
  parts.push(
    { text: data.model, tone: "accent", kind: "model" },
    { text: data.thinking, tone: "muted", kind: "thinking" },
  );
  if (data.fast !== null) parts.push({ text: "fast", tone: data.fast === "on" ? "blocked" : "dim", kind: "fast" });
  if (data.speed !== undefined) parts.push({ text: `${data.speed} t/s`, tone: "muted", kind: "speed" });
  parts.push({ text: `$${data.cost.toFixed(2)}`, tone: "muted", kind: "cost" });
  if (data.contextWindow > 0) {
    const percent = data.contextTokens / data.contextWindow * 100;
    parts.push({ text: `ctx ${percent.toFixed(1)}%`, tone: percent > 60 ? "blocked" : "accent", kind: "context" });
  }
  const usage = data.usage;
  if (usage) {
    // Background polling must not change label widths. Loading belongs in the
    // hover details once a snapshot exists, not a temporary suffix on both quotas.
    const health = usage.status === "stale" ? " ~" : usage.status === "error" ? " !" : "";
    for (const [label, value, reset] of [["5h", usage.fiveHourUsed, usage.fiveHourResetAt], ["wk", usage.weeklyUsed, usage.weeklyResetAt]]) {
      if (value !== undefined) parts.push({ text: `${label} ${Math.round(value)}%${health}`, tone: value > 90 ? "blocked" : value > 70 ? "working" : "accent", kind: "usage",
        tooltip: [`${label === "5h" ? "5-hour" : "Weekly"} quota resets: ${resetTime(reset, now)}`, usageHealth(usage)].filter(Boolean).join("\n") });
    }
    if (usage.availableResets !== undefined) parts.push({ text: `↺${usage.availableResets}`, tone: "muted", kind: "resets", tooltip: resetCreditTooltip(usage, now) });
    if (usage.fiveHourUsed === undefined && usage.weeklyUsed === undefined && (health || usage.status === "loading")) parts.push({ text: `usage${health || " …"}`, tone: "working", kind: "usage", tooltip: footerTooltip(data, now) });
  }
  return parts;
}

export function metricControl(data, kind) {
  if (!data?.controls?.actions.includes(kind)) return null;
  const labels = { model: "Click to cycle models", thinking: "Click to cycle thinking levels", fast: "Click to toggle Fast" };
  return { enabled: data.controls.idle, tooltip: data.controls.idle ? labels[kind] : "Available when Pi is idle" };
}

export function controlInvocation(data, address, action) {
  const controls = data.controls;
  const slash = address.lastIndexOf("/");
  return {
    command: controls.node,
    args: [controls.client, controls.socket, controls.owner, controls.session, action],
    on: slash < 0 ? null : address.slice(0, slash),
  };
}

/** Less-critical metrics hide on narrow windows; supplemental reset detail stays in the tooltip. */
export function visibleMetricParts(parts, width) {
  return parts.filter(part => {
    if (part.kind === "speed" || part.kind === "resets") return width >= 1000;
    if (part.kind === "usage") return width >= 780;
    if (part.kind === "cost" || part.kind === "git") return width >= 600;
    if (part.kind === "thinking" || part.kind === "fast") return width >= 420;
    return true;
  });
}
