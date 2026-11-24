const curves = ['smooth', 'linear', 'exponential'];
const fields = ['wpm', 'farnsworth', 'tone', 'volume', 'rise', 'fall', 'curve'];

export function nativeSound(settings) {
  return { wpm: settings.wpm, farnsworth: settings.farnsworth, keyer: settings.keyer,
    pitch: settings.tone, volume: settings.volume, rise: settings.rise, fall: settings.fall, curve: curves.indexOf(settings.curve) };
}

// Only offer choices backed by an old save. A new helper's defaults do not
// imply a player chose a second pitch, volume or envelope.
export function previousSounds(profile, native) {
  const current = Object.fromEntries(fields.map(key => [key, profile.settings[key]]));
  const options = [{ label: 'Listen', settings: current }];
  function add(label, settings) {
    if (!options.some(o => fields.every(k => o.settings[k] === settings[k]))) options.push({ label, settings });
  }
  if (profile.previousTiming) add('Send', { ...current, ...profile.previousTiming });
  if (native && !native.sharedSound && (native.hasTone || native.hasVolume)) {
    const settings = { ...current };
    if (native.hasTone) Object.assign(settings, { wpm: native.wpm, farnsworth: native.spacing,
      tone: 50 * Math.round(native.pitch / 50), rise: native.rise, fall: native.fall, curve: curves[native.curve] });
    if (native.hasVolume) settings.volume = native.volume;
    add('Paddle', settings);
  }
  return options;
}
