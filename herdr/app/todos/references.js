const title = item => item.title.replace(/\s+/g, " ").trim();

export function todoReference(item) {
  return `TODO-${item.id.replace(/^TODO-/i, "")} — ${title(item)}`;
}

export function ideaReference(item) {
  // Full Work IDs stay unambiguous when pasted into a different project/chat.
  return `${item.id} — ${title(item)}`;
}
