/** The actual terminal replacement and app activation both matter. Remote panes are excluded. */
export function terminalFocused(address, focus, active) {
  return active === true && (focus?.shown || focus?.terminal) === address;
}

/** Closed observed spans only. No timers, promises tied to a dead mod, or stale extrapolation. */
export class FocusReporter {
  constructor(provider, providerStartedAt = Date.now()) {
    this.provider = provider;
    this.providerStartedAt = providerStartedAt;
    this.records = new Map();
    this.sequence = 0;
  }
  observe(key, focused, at, epoch = 0) {
    const previous = this.records.get(key);
    if (previous && previous.focused === focused && previous.epoch === epoch) return null;
    const next = { at, focused, epoch, sequence: ++this.sequence };
    this.records.set(key, next);
    if (!previous || at <= previous.at) return null;
    return { provider: this.provider, providerStartedAt: this.providerStartedAt, sequence: next.sequence, start: previous.at, end: at, focused: previous.focused };
  }
  forget(key) { this.records.delete(key); }
}
