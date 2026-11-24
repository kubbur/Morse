import { timeline, timing } from './morse.mjs';

// Both series use milliseconds since the first key-down. Native marks arrive
// with audio-frame timestamps; this view never drives audio or grading.
export function sendingTrace(target, settings, edges) {
  const dit = timing(settings.wpm, settings.farnsworth).dit * 1000;
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
  return { expected, actual, duration, dit };
}

export function timingFeedback({ expected, actual }, complete) {
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
    if (i) consider('Mark '+(i+1), mark.start-sent[i-1].end, ref.start-expected[i-1].end, true);
    consider('Mark '+(i+1), mark.end-mark.start, ref.end-ref.start, false);
  }
  if (!largest?.error) return complete ? 'Marks and gaps matched to the nearest millisecond.' : '';
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
  constructor(root) {
    this.root = root;
    this.scroll = root.querySelector('.trace-scroll');
    this.plot = root.querySelector('.trace-plot');
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(this.scroll);
  }

  set(data, caption, complete) {
    this.data = data; this.caption = caption; this.complete = complete;
    this.root.hidden = !data || !data.expected.length && !data.actual.length;
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
    const layers = document.createDocumentFragment();
    const rough = 80 / scale, base = 10 ** Math.floor(Math.log10(rough));
    const step = ([1,2,5,10].find(n => n * base >= rough) || 10) * base;
    for (let ms = 0; x(ms) < width - 36; ms += step) {
      const tick = node('span','trace-tick',ms < 1000 ? ms+' ms' : +(ms / 1000).toFixed(2)+' s');
      tick.style.left=x(ms)+'px'; layers.append(tick);
    }
    for (const [kind, marks] of [['target',expected],['sent',actual]]) {
      for (const mark of marks) {
        const bar = node('i','trace-bar trace-'+kind);
        bar.style.left=x(mark.start)+'px';
        bar.style.width=Math.max(2, ((mark.end ?? mark.start) - mark.start) * scale)+'px';
        layers.append(bar);
      }
    }
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
