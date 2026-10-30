// Presentation only: preserve the original descriptions and paths in the feeds.
export function compactPath(path, home) {
  if (!path) return "No focused folder";
  const root = home?.replace(/[\\/]+$/, "");
  if (!root) return path;
  if (path === root) return "~";
  if (path.startsWith(root + "/") || path.startsWith(root + "\\")) return "~" + path.slice(root.length);
  return path;
}

export function updatedAt(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Updated time unavailable";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = number => String(number).padStart(2, "0");
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()} · ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ideaDescription(description) {
  // Only remove a trailing migration-provenance line (and its optional rule),
  // never matching prose elsewhere or editing the underlying Work record.
  const lines = description.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (!/^Imported from Pi:\s+.+$/i.test(lines.at(-1) ?? "")) return description;
  // A marker inside a fenced code sample is content, not migration metadata.
  const fences = lines.slice(0, -1).filter(line => /^\s*(```|~~~)/.test(line));
  if (fences.length % 2) return description;
  lines.pop();
  while (!lines.at(-1)?.trim() && lines.length) lines.pop();
  if (/^\s*(---|\*\*\*|___)\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  return lines.join("\n").trimEnd();
}
