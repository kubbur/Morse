import { timeline, timing } from './morse.mjs';
import { sendingGapType } from './sending.mjs';

// Both series use milliseconds since the first key-down. Native marks arrive
// with audio-frame timestamps; this view never drives audio or grading.
export function sendingTrace(target, settings, edges, { keyerTimed = false, tolerance = 0.5 } = {}) {
  const time = timing(settings.wpm, settings.farnsworth);
  const dit = time.dit * 1000;
  const expected = target ? timeline(target, settings).tones.map(t => ({
    start: t.start * 1000, end: (t.start + t.duration) * 1000,
  })) : [];
  const actual = [];
  const origin = edges[0]?.at || 0;
  for (let i = 0; i < edges.length; i += 2) {
    actual.push({ start: edges[i].at - origin, end: edges[i + 1] ? edges[i + 1].at - origin : null });
  }
  const last = actual.at(-1);
  const duration = Math.max(dit * 4, expected.at(-1)?.end || 0, last?.end ?? last?.start ?? 0) + dit;
  return { expected, actual, duration, dit, time, keyerTimed, tolerance };
}

function precise(value, ideal) {
  const windowMs = Math.min(45, Math.max(4, ideal * 0.12));
  return Math.abs(value - ideal) <= windowMs + 1e-6;
}

// The first mark sets the origin. Each following gap is measured from the
// previous release, so one late letter does not spoil every later hit.
export function markFeedback({ expected, actual, dit, time, keyerTimed, tolerance }) {
  if (!expected.length) return [];
  const hits = [];
  let streak = 0;
  for (const [i, mark] of actual.entries()) {
    if (mark.end === null) break;
    const ref = expected[i];
    let matched = false, perfect = false, timed = false, label = 'Extra mark';
    if (ref) {
      const length = mark.end - mark.start, ideal = ref.end - ref.start;
      const symbol = ideal < 2 * dit ? 'Dit' : 'Dah';
      const correctSymbol = (length < 2 * dit) === (symbol === 'Dit');
      const gap = i ? mark.start - actual[i - 1].end : 0;
      const idealGap = i ? ref.start - expected[i - 1].end : 0;
      const boundary = sendingGapType(idealGap, time);
      const wrongBoundary = i > 0 && sendingGapType(gap, time) !== boundary;
      const timedGap = i > 0 && (!keyerTimed || boundary !== 'element');
      timed = !keyerTimed || timedGap;
      const gapError = timedGap ? Math.abs(gap / idealGap - 1) : 0;
      const lengthError = keyerTimed ? 0 : Math.abs(length / ideal - 1);
      const limit = tolerance + 1e-6;
      if (!correctSymbol) label = 'Expected a ' + symbol.toLowerCase();
      else if (wrongBoundary || (gapError > limit && gapError >= lengthError)) {
        label = Math.round(Math.abs(gap - idealGap)) + ' ms ' + (gap < idealGap ? 'early' : 'late');
      } else if (lengthError > limit) {
        label = Math.round(Math.abs(length - ideal)) + ' ms ' + (length < ideal ? 'short' : 'long');
      } else {
        matched = true;
        perfect = timed && (keyerTimed || precise(length, ideal)) && (!timedGap || precise(gap, idealGap));
        if (keyerTimed && !timedGap) label = symbol + ' matched';
        else if (keyerTimed) label = perfect ? 'Perfect gap' : 'Gap on time';
        else label = perfect ? 'Perfect' : 'On time';
      }
    }
    streak = matched ? streak + 1 : 0;
    hits.push({ matched, perfect, timed, label, streak });
  }
  return hits;
}

function wholeSend(data, hits) {
  if (!hits.length || hits.length !== data.expected.length || hits.length !== data.actual.length) return null;
  if (!hits.every(hit => hit.matched && (!hit.timed || hit.perfect))) return null;
  if (!hits.some(hit => hit.timed)) return { kind:'clean', label:'Clean send' };
  return { kind:'perfect', label:data.keyerTimed ? 'Perfect spacing' : 'Perfect send' };
}

export function timingFeedback({ expected, actual, time, keyerTimed }, complete) {
  const sent = actual.filter(mark => mark.end !== null);
  if (!sent.length || !expected.length) return '';
  if (complete && sent.length !== expected.length) return `${sent.length} of ${expected.length} expected marks sent.`;
  let largest;
  function consider(name, value, ideal, gap) {
    const error = Math.round(value - ideal);
    if (!largest || Math.abs(error) > Math.abs(largest.error)) largest = { name, error, gap };
  }
  for (let i = 0; i < Math.min(sent.length, expected.length); i++) {
    const mark = sent[i], ref = expected[i];
    if (i) {
      const gap = mark.start - sent[i-1].end, idealGap = ref.start - expected[i-1].end;
      if (!keyerTimed || sendingGapType(idealGap,time) !== 'element' || sendingGapType(gap,time) !== 'element') consider('Mark '+(i+1), gap, idealGap, true);
    }
    if (!keyerTimed) consider('Mark '+(i+1), mark.end-mark.start, ref.end-ref.start, false);
  }
  if (!largest) return '';
  if (!largest.error) return complete ? (keyerTimed ? 'Spacing' : 'Marks and gaps') + ' matched to the nearest millisecond.' : '';
  const { name, error, gap } = largest;
  if (gap) return `${name} started ${Math.abs(error)} ms ${error < 0 ? 'early' : 'late'} after the previous mark.`;
  return `${name} was ${Math.abs(error)} ms too ${error < 0 ? 'short' : 'long'}.`;
}

function handGuide(data, next, cursor) {
  if (!next || !cursor) return null;
  if (cursor.end === null) {
    return data.keyerTimed ? null : { start:cursor.start, end:cursor.start + (next.end - next.start) };
  }
  const gap = next.start - data.expected[data.actual.length - 1].end;
  if (data.keyerTimed && sendingGapType(gap, data.time) === 'element') return null;
  return { start:cursor.end, end:cursor.end + gap };
}

const node = (tag, className, text) => {
  const el = document.createElement(tag); el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};

export class SendingTraceView {
  constructor(root, verdict) {
    this.root = root;
    this.verdict = verdict;
    this.scroll = root.querySelector('.trace-scroll');
    this.plot = root.querySelector('.trace-plot');
    this.marks = node('div', 'trace-marks');
    this.effects = node('div', 'trace-effects');
    this.effects.setAttribute('aria-hidden', 'true');
    this.plot.append(this.marks, this.effects);
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.paintedReleases = 0;
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.scroll);
  }

  set(data, complete, passed = false) {
    // Removing a guided target is synchronous. A rapid first blind press can
    // make the plot visible again before its next animation frame.
    const last = data?.actual.at(-1);
    const previous = this.data?.actual.at(-1);
    if ((!data?.expected.length && this.data?.expected.length) || (!last && previous)) {
      this.marks.replaceChildren();
      this.effects.replaceChildren();
      this.plot.removeAttribute('aria-label');
      this.root.querySelector('.trace-target-key').hidden = true;
      this.root.querySelector('.trace-caption').textContent = '';
      this.root.querySelector('.trace-feedback').textContent = '';
    }
    if (!last || (data.actual.length === 1 && last.end === null && (previous?.end !== null || this.complete))) {
      this.paintedReleases = 0;
      this.lastSparkAt = -Infinity;
      this.effects.replaceChildren();
    }
    const changed = previous?.start !== last?.start || previous?.end !== last?.end || this.data?.actual.length !== data?.actual.length;
    if (changed && last) this.edgeSince = performance.now();
    if (changed || !last || (complete && !passed)) {
      this.liveFinish = null;
      delete this.verdict.dataset.finish;
      this.fireworks?.remove();
      this.fireworks = null;
    }
    if (!last) {
      this.verdict.querySelector('.trace-call').textContent = '';
      this.verdict.querySelector('.trace-streak').textContent = '';
      this.scroll.scrollLeft = 0;
    }
    this.data = data; this.complete = complete; this.passed = passed;
    this.root.hidden = !data || !data.expected.length && !data.actual.length;
    if (!last || (!data.expected.length && !this.liveFinish)) this.verdict.hidden = true;
    if (!this.root.hidden) this.schedule();
  }

  // Show the match while the player can still see this answer. Later marks
  // can invalidate it. Only the normal end-of-answer check awards XP.
  showMatchedSend(reference) {
    if (this.complete || this.liveFinish) return;
    const finish = wholeSend(reference, markFeedback(reference));
    if (!finish) return;
    this.liveFinish = finish;
    this.celebrate(finish.kind);
    this.schedule();
  }

  schedule() {
    if (this.frame || !this.data || this.root.hidden) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }

  strike(at, kind) {
    const now = performance.now();
    if (this.reducedMotion.matches) return;
    if (now - this.lastSparkAt < 120 && (kind === 'match' || this.lastSparkKind !== 'match')) return;
    this.lastSparkAt = now;
    this.lastSparkKind = kind;
    const burst = node('span', 'trace-burst');
    burst.dataset.kind = kind;
    burst.dataset.at = at;
    if (kind !== 'match') {
      for (let i = 0; i < 5; i++) burst.append(node('i', 'trace-spark'));
    }
    while (this.effects.childElementCount >= 2) this.effects.firstElementChild.remove();
    this.effects.append(burst);
    const remove = event => { if (event.target === burst) burst.remove(); };
    burst.addEventListener('animationend', remove);
    burst.addEventListener('animationcancel', remove);
  }

  celebrate(kind) {
    if (this.reducedMotion.matches) return;
    const layer = node('div', 'send-fireworks');
    layer.dataset.kind = kind;
    layer.setAttribute('aria-hidden', 'true');
    for (let shell = 0; shell < 3; shell++) {
      const bloom = node('span', 'send-firework');
      for (let angle = 0; angle < 360; angle += 40) {
        const ray = node('i', 'firework-ray');
        ray.style.setProperty('--angle', angle + 'deg');
        bloom.append(ray);
      }
      layer.append(bloom);
    }
    // Anchor to the visible panel even when the timing plot is many screens wide.
    this.root.closest('.send-capture').append(layer);
    this.fireworks = layer;
    const remove = event => {
      if (event.target !== layer || event.pseudoElement) return;
      layer.remove();
      if (this.fireworks === layer) this.fireworks = null;
    };
    layer.addEventListener('animationend', remove);
    layer.addEventListener('animationcancel', remove);
  }

  draw() {
    const data = this.data, visible = this.scroll.clientWidth;
    if (!data || this.root.hidden || !visible) return;
    const { expected, actual, dit } = data;
    const cursor = actual.at(-1);
    const held = cursor?.end === null;
    const next = expected[held ? actual.length - 1 : actual.length];
    const guide = this.complete ? null : handGuide(data, next, cursor);
    const duration = Math.max(data.duration, (guide?.end ?? 0) + dit);
    const width = Math.max(visible, Math.min(24000, Math.ceil(duration / dit * 7)));
    const padding = 8, scale = (width - 2 * padding) / duration;
    const x = ms => padding + ms * scale;
    this.plot.style.width = width+'px';
    const hits = markFeedback(data);
    const missing = this.complete ? expected.length - hits.length : 0;
    const latest = missing > 0 ? { matched: false, label: missing === 1 ? '1 mark missing' : missing + ' marks missing', streak: 0 } : hits.at(-1);
    const finish = this.complete ? (this.passed && wholeSend(data, hits)) : this.liveFinish;
    if (finish) this.verdict.dataset.finish = finish.kind;
    else delete this.verdict.dataset.finish;
    if (finish || latest) {
      this.verdict.dataset.hit = latest?.perfect || finish?.kind === 'perfect' ? 'perfect' : (finish || latest?.matched) ? 'match' : 'miss';
      this.verdict.querySelector('.trace-call').textContent = finish?.label ?? latest.label;
      this.verdict.querySelector('.trace-streak').textContent = latest?.streak >= 2 ? latest.streak + ' in a row' : '';
    }
    this.verdict.hidden = !latest && !finish;
    const layers = document.createDocumentFragment();
    const rough = 80 / scale, base = 10 ** Math.floor(Math.log10(rough));
    const step = ([1,2,5,10].find(n => n * base >= rough) || 10) * base;
    for (let ms = 0; x(ms) < width - 36; ms += step) {
      const tick = node('span','trace-tick',ms < 1000 ? ms+' ms' : +(ms / 1000).toFixed(2)+' s');
      tick.style.left=x(ms)+'px'; layers.append(tick);
    }
    if (guide) {
      const marker = node('span', held ? 'trace-gate' : 'trace-gap');
      marker.style.left = x(held ? guide.end : guide.start) + 'px';
      if (!held) {
        const gap = guide.end - guide.start;
        marker.style.width = gap * scale + 'px';
        marker.style.setProperty('--gap-time', gap + 'ms');
        marker.style.setProperty('--gap-delay', -(performance.now() - this.edgeSince) + 'ms');
      }
      layers.append(marker);
    }
    for (const [kind, marks] of [['target',expected],['sent',actual]]) {
      for (const [index, mark] of marks.entries()) {
        const bar = node('i','trace-bar trace-'+kind);
        bar.style.left=x(mark.start)+'px';
        bar.style.width=Math.max(2, ((mark.end ?? mark.start) - mark.start) * scale)+'px';
        const hit = hits[index];
        if (hit) {
          bar.dataset.hit = hit.matched ? 'match' : 'miss';
          if (hit.perfect && (!data.keyerTimed || kind === 'sent')) bar.classList.add('trace-perfect');
          if (kind === 'sent' && hit.perfect && data.keyerTimed) {
            bar.classList.add('trace-at-press');
            const gap = node('span', 'trace-gap-hit');
            const previousEnd = actual[index - 1].end;
            gap.style.left = x(previousEnd) + 'px';
            gap.style.width = (mark.start - previousEnd) * scale + 'px';
            layers.append(gap);
          }
          if (kind === 'sent' && finish?.kind === 'clean' && index === actual.length - 1) bar.classList.add('trace-clean');
        } else if (kind === 'target' && missing > 0) {
          bar.dataset.hit = 'missing';
        } else if (actual[index]?.end === null) {
          if (kind === 'target') bar.classList.add('trace-aim');
          else {
            const remaining = duration - mark.start;
            bar.classList.add('trace-held');
            bar.style.setProperty('--held-width',Math.max(2, remaining * scale)+'px');
            bar.style.setProperty('--held-time',remaining+'ms');
            bar.style.animationDelay = -Math.max(0, performance.now() - this.edgeSince)+'ms';
          }
        } else if (kind === 'target' && mark === next && !this.complete) {
          bar.classList.add('trace-next');
          if (guide) bar.style.setProperty('--press-offset', (guide.end - mark.start) * scale + 'px');
        }
        layers.append(bar);
      }
    }
    this.marks.replaceChildren(layers);
    // Keep bursts outside the redrawn marks. A new dit or resize must neither
    // cut a burst short nor replay old hits. Coalesced edges get one effect.
    const lastHit = hits.at(-1);
    const landed = actual[hits.length - 1];
    const newHit = hits.length > this.paintedReleases;
    if (lastHit?.matched && newHit && !this.complete) {
      const at = lastHit.perfect && data.keyerTimed ? landed.start : landed.end;
      this.strike(at, lastHit.perfect ? 'perfect' : 'match');
    }
    for (const burst of this.effects.children) burst.style.left = x(Number(burst.dataset.at)) + 'px';
    this.paintedReleases = actual.length - (held ? 1 : 0);
    const end = cursor ? x(cursor.end ?? cursor.start) : 0;
    const stamp = cursor?.end ?? cursor?.start;
    if (!cursor) this.scroll.scrollLeft = 0;
    else if (stamp !== this.stamp && (end < this.scroll.scrollLeft || end > this.scroll.scrollLeft + visible - padding))
      this.scroll.scrollLeft = Math.max(0, end - visible + 2 * padding);
    this.stamp = stamp;
    this.root.querySelector('.trace-target-key').hidden = !expected.length;
    this.root.querySelector('.trace-caption').textContent = expected.length && !data.keyerTimed && !this.complete ? 'Release at the line' : '';
    const feedback = timingFeedback(data, this.complete);
    this.root.querySelector('.trace-feedback').textContent = feedback;
    this.plot.setAttribute('aria-label', [
      expected.length ? 'Target marks in milliseconds: '+expected.map(m=>Math.round(m.start)+' to '+Math.round(m.end)).join(', ') : '',
      actual.length ? 'Your marks in milliseconds: '+actual.map(m=>Math.round(m.start)+' to '+(m.end==null?'held':Math.round(m.end))).join(', ') : '',
    ].filter(Boolean).join('. '));
  }
}
