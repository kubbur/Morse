const inputKey = 'morse.send-input.v1';
const inputs = ['paddle', 'vband', 'straight', 'keyboard'];

export function loadInput() {
  try {
    const value = globalThis.localStorage.getItem(inputKey);
    if (inputs.includes(value)) return value;
  } catch { /* Practice is still available when storage is blocked. */ }
  return 'paddle';
}

export function saveInput(value) {
  if (inputs.includes(value)) {
    try { globalThis.localStorage.setItem(inputKey, value); } catch { /* Keep the choice for this session. */ }
  }
}

function controlSide(event) {
  if (event.code === 'ControlLeft') return 1;
  if (event.code === 'ControlRight') return 2;
  if ((!event.code || event.code === 'Unidentified') && event.key === 'Control' && [1, 2].includes(event.location)) return event.location;
  return 0;
}

// The adapter presents two independent keyboard modifiers. ctrlKey alone
// cannot distinguish a squeeze from a single contact, or identify a release.
export class VBandKeys {
  constructor(change, interrupted, { start = setTimeout, stop = clearTimeout, now = () => performance.now() } = {}) {
    Object.assign(this, { change, interrupted, start, stop, now });
    this.mask = 0;
    this.blocked = 0;
    this.timers = new Map();
  }

  cancel() {
    const previous = this.mask;
    this.blocked |= previous;
    this.mask = 0;
    for (const timer of this.timers.values()) this.stop(timer);
    this.timers.clear();
    return !!previous;
  }

  interrupt() {
    if (this.cancel()) this.interrupted();
  }

  handle(event, down, enabled) {
    const side = controlSide(event);
    if (!side) {
      if (down && this.mask) this.interrupt();
      return false;
    }
    if (!down && (this.blocked & side)) {
      this.blocked &= ~side;
      return false;
    }
    if (down && (!enabled || event.altKey || event.metaKey || event.shiftKey || event.isComposing || this.blocked)) {
      this.interrupt();
      this.blocked |= side;
      return false;
    }
    if (!down && !(this.mask & side)) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (Number.isFinite(event.timeStamp)) {
      const stamp = event.timeStamp > 1e12 ? event.timeStamp - performance.timeOrigin : event.timeStamp;
      const age = this.now() - stamp;
      if (age > 100 || age < -10) {
        this.cancel();
        if (down) this.blocked |= side;
        else this.blocked &= ~side;
        this.interrupted();
        return true;
      }
    }
    if (down) {
      if (event.repeat || (this.mask & side)) return true;
      this.mask |= side;
      this.timers.set(side, this.start(() => this.interrupt(), 10000));
    } else {
      this.mask &= ~side;
      this.stop(this.timers.get(side));
      this.timers.delete(side);
    }
    this.change(this.mask, side === 1 ? 'dit' : 'dah', down);
    return true;
  }
}
