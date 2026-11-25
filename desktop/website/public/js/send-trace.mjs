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

// The first mark sets the origin. Each following gap is measured from the
// previous release, so one late letter does not spoil every later hit.
export function markFeedback({ expected, actual, dit, time, keyerTimed, tolerance }) {
  if (!expected.length) return [];
  const hits = [];
  let streak = 0;
  for (const [i, mark] of actual.entries()) {
    if (mark.end === null) break;
    const ref = expected[i];
    let matched = false, label = 'Extra mark';
    if (ref) {
      const length = mark.end - mark.start, ideal = ref.end - ref.start;
      const symbol = ideal < 2 * dit ? 'Dit' : 'Dah';
      const correctSymbol = (length < 2 * dit) === (symbol === 'Dit');
      const gap = i ? mark.start - actual[i - 1].end : 0;
      const idealGap = i ? ref.start - expected[i - 1].end : 0;
      const boundary = sendingGapType(idealGap, time);
      const wrongBoundary = i > 0 && sendingGapType(gap, time) !== boundary;
      const gapError = i && (!keyerTimed || boundary !== 'element') ? Math.abs(gap / idealGap - 1) : 0;
      const lengthError = keyerTimed ? 0 : Math.abs(length / ideal - 1);
      const limit = tolerance + 1e-6;
      if (!correctSymbol) label = 'Expected a ' + symbol.toLowerCase();
      else if (wrongBoundary || (gapError > limit && gapError >= lengthError)) {
        label = Math.round(Math.abs(gap - idealGap)) + ' ms ' + (gap < idealGap ? 'early' : 'late');
      } else if (lengthError > limit) {
        label = Math.round(Math.abs(length - ideal)) + ' ms ' + (length < ideal ? 'short' : 'long');
      } else {
        matched = true;
        label = !keyerTimed ? 'On time' : i && boundary !== 'element' ? 'Gap on time' : symbol + ' matched';
      }
    }
    streak = matched ? streak + 1 : 0;
    hits.push({ matched, label, streak });
  }
  return hits;
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
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.scroll);
  }

  set(data, caption, complete) {
    // Removing a guided target is synchronous. A rapid first blind press can
    // make the plot visible again before its next animation frame.
    if (!data?.expected.length && this.data?.expected.length) {
      this.plot.replaceChildren();
      this.plot.removeAttribute('aria-label');
      this.root.querySelector('.trace-target-key').hidden = true;
      this.root.querySelector('.trace-caption').textContent = '';
      this.root.querySelector('.trace-feedback').textContent = '';
    }
    this.data = data; this.caption = caption; this.complete = complete;
    const last = data?.actual.at(-1);
    if (last?.end === null) {
      if (this.heldStart !== last.start) this.heldSince = performance.now();
      this.heldStart = last.start;
    } else this.heldStart = null;
    if (!last || (data.actual.length === 1 && last.end === null)) this.paintedHits = 0;
    this.root.hidden = !data || !data.expected.length && !data.actual.length;
    if (this.root.hidden || !data.expected.length || !data.actual.length) this.verdict.hidden = true;
    if (!this.root.hidden) this.schedule();
  }

  schedule() {
    if (this.frame || !this.data || this.root.hidden) return;
    this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
  }

  draw() {
    const data = this.data, visible = this.scroll.clientWidth;
    if (!data || this.root.hidden || !visible) return;
    const { expected, actual, duration, dit } = data;
    const width = Math.max(visible, Math.min(24000, Math.ceil(duration / dit * 7)));
    const padding = 8, scale = (width - 2 * padding) / duration;
    const x = ms => padding + ms * scale;
    this.plot.style.width = width+'px';
    const hits = markFeedback(data);
    const missing = this.complete ? expected.length - hits.length : 0;
    const latest = missing > 0 ? { matched: false, label: missing === 1 ? '1 mark missing' : missing + ' marks missing', streak: 0 } : hits.at(-1);
    if (latest) {
      this.verdict.dataset.hit = latest.matched ? 'match' : 'miss';
      this.verdict.querySelector('.trace-call').textContent = latest.label;
      this.verdict.querySelector('.trace-streak').textContent = latest.streak >= 2 ? latest.streak + ' in a row' : '';
    }
    this.verdict.hidden = !latest;
    const layers = document.createDocumentFragment();
    const rough = 80 / scale, base = 10 ** Math.floor(Math.log10(rough));
    const step = ([1,2,5,10].find(n => n * base >= rough) || 10) * base;
    for (let ms = 0; x(ms) < width - 36; ms += step) {
      const tick = node('span','trace-tick',ms < 1000 ? ms+' ms' : +(ms / 1000).toFixed(2)+' s');
      tick.style.left=x(ms)+'px'; layers.append(tick);
    }
    for (const [kind, marks] of [['target',expected],['sent',actual]]) {
      for (const [index, mark] of marks.entries()) {
        const bar = node('i','trace-bar trace-'+kind);
        bar.style.left=x(mark.start)+'px';
        bar.style.width=Math.max(2, ((mark.end ?? mark.start) - mark.start) * scale)+'px';
        const hit = hits[index];
        if (hit) {
          bar.dataset.hit = hit.matched ? 'match' : 'miss';
          if (kind === 'target' && hit.matched && index === hits.length - 1 && hits.length > this.paintedHits && !this.complete) bar.classList.add('trace-strike');
        } else if (kind === 'target' && missing > 0) {
          bar.dataset.hit = 'missing';
        } else if (actual[index]?.end === null) {
          if (kind === 'target') bar.classList.add('trace-aim');
          else {
            const remaining = duration - mark.start;
            bar.classList.add('trace-held');
            bar.style.setProperty('--held-width',Math.max(2, remaining * scale)+'px');
            bar.style.setProperty('--held-time',remaining+'ms');
            bar.style.animationDelay = -Math.max(0, performance.now() - this.heldSince)+'ms';
          }
        }
        layers.append(bar);
      }
    }
    this.paintedHits = hits.length;
    this.plot.replaceChildren(layers);
    const cursor = actual.at(-1);
    const end = cursor ? x(cursor.end ?? cursor.start) : 0;
    const stamp = cursor?.end ?? cursor?.start;
    if (!cursor) this.scroll.scrollLeft = 0;
    else if (stamp !== this.stamp && (end < this.scroll.scrollLeft || end > this.scroll.scrollLeft + visible - padding))
      this.scroll.scrollLeft = Math.max(0, end - visible + 2 * padding);
    this.stamp = stamp;
    this.root.querySelector('.trace-target-key').hidden = !expected.length;
    this.root.querySelector('.trace-caption').textContent = this.caption;
    const feedback = timingFeedback(data, this.complete);
    this.root.querySelector('.trace-feedback').textContent = feedback;
    this.plot.setAttribute('aria-label', [
      expected.length ? 'Target marks in milliseconds: '+expected.map(m=>Math.round(m.start)+' to '+Math.round(m.end)).join(', ') : '',
      actual.length ? 'Your marks in milliseconds: '+actual.map(m=>Math.round(m.start)+' to '+(m.end==null?'held':Math.round(m.end))).join(', ') : '',
    ].filter(Boolean).join('. '));
  }
}
