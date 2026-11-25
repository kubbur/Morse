const storageKey = 'morse.keyboard-paddles.v1';
const defaults = { dit: 'z', dah: 'x', showButtons: true };

// Match the character produced by the player's layout. The physical key code
// is used separately to release that same contact if Shift changes mid-hold.
export function paddleCharacter(value) {
  if (typeof value !== 'string') return '';
  const char = value.normalize('NFC');
  if (!/^[\p{L}\p{N}\p{P}\p{S} ]$/u.test(char)) return '';
  const lower = char.toLowerCase();
  return [...lower].length === 1 ? lower : char;
}

export function keyLabel(char) {
  if (char === ' ') return 'Space';
  const upper = char.toUpperCase();
  return [...upper].length === 1 ? upper : char;
}

export function loadKeyboardPaddles() {
  try {
    const saved = JSON.parse(globalThis.localStorage.getItem(storageKey));
    const dit = paddleCharacter(saved?.dit), dah = paddleCharacter(saved?.dah);
    return { ...(dit && dah && dit !== dah ? { dit, dah } : defaults), showButtons: saved?.showButtons !== false };
  } catch { return { ...defaults }; }
}

export function saveKeyboardPaddles(settings) {
  try { globalThis.localStorage.setItem(storageKey, JSON.stringify(settings)); return true; }
  catch { return false; }
}
