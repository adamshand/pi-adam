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
      || [usage.fiveHourUsed, usage.weeklyUsed, usage.availableResets].some(value => value !== undefined && !finite(value)))) return null;
    const controls = data.controls;
    if (controls !== undefined && (!controls || !text(controls.socket) || !text(controls.owner)
      || !text(controls.node) || !text(controls.client) || controls.session !== data.session_id
      || typeof controls.idle !== "boolean" || !Array.isArray(controls.actions)
      || controls.actions.some(action => !["model", "thinking", "fast"].includes(action)))) return null;
    return data;
  } catch { return null; }
}

export function metricParts(data) {
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
    const health = usage.status === "stale" ? " ~" : usage.status === "error" ? " !" : usage.status === "loading" ? " …" : "";
    for (const [label, value] of [["5h", usage.fiveHourUsed], ["wk", usage.weeklyUsed]]) {
      if (value !== undefined) parts.push({ text: `${label} ${Math.round(value)}%${health}`, tone: value > 90 ? "blocked" : value > 70 ? "working" : "accent", kind: "usage" });
    }
    if (usage.availableResets !== undefined) parts.push({ text: `↺${usage.availableResets}`, tone: "muted", kind: "resets" });
    if (usage.fiveHourUsed === undefined && usage.weeklyUsed === undefined && health) parts.push({ text: `usage${health}`, tone: "working", kind: "usage" });
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

/** Less-critical metrics move into the full tooltip on narrow windows. */
export function visibleMetricParts(parts, width) {
  return parts.filter(part => {
    if (part.kind === "speed" || part.kind === "resets") return width >= 1000;
    if (part.kind === "usage") return width >= 780;
    if (part.kind === "cost" || part.kind === "git") return width >= 600;
    if (part.kind === "thinking" || part.kind === "fast") return width >= 420;
    return true;
  });
}
