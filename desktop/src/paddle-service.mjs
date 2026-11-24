import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const integer = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export function validCommand(op, v) {
  switch (op) {
    case 'status': case 'arm': case 'disarm': case 'interrupt':
    case 'vband-release': case 'calibrate': case 'cancelCalibration': case 'automatic': return v == null;
    case 'input': return ['off','paddle','vband'].includes(v);
    case 'vband': return !!v && integer(v.mask,0,3) && integer(v.epoch,0,0xffffffff) && Number.isSafeInteger(v.session) && v.session > 0;
    case 'sample': case 'mute': case 'reverse': case 'word-spaces': return typeof v === 'boolean';
    case 'volume': return integer(v, 0, 100);
    case 'output': return typeof v === 'string' && v.length > 0 && v.length <= 512;
    case 'sound': return validCommand('keyer',v) && integer(v.pitch,200,2000) && v.pitch%50===0 && integer(v.rise,1,30) && integer(v.fall,1,30) && integer(v.curve,0,2) && integer(v.volume,0,100);
    case 'keyer': return v && integer(v.wpm, 5, 80) && integer(v.farnsworth, 1, v.wpm) && ['a','b'].includes(v.keyer);
    case 'envelope': return v && integer(v.pitch, 200, 2000) && integer(v.rise, 1, 30) && integer(v.fall, 1, 30) && integer(v.curve, 0, 2) && typeof v.wordSpaces === 'boolean';
    default: return false;
  }
}

export class PaddleService {
  constructor(executable, directory, publish, isolated = false) {
    Object.assign(this, { executable, directory, publish, isolated });
    this.pending = new Map();
    this.serial = 0;
    this.input = 'off';
    this.generation = 0;
    this.stopped = false;
  }
  start() {
    if (this.child || this.stopped) return;
    const child = this.child = spawn(this.executable, [this.directory, this.isolated ? 'isolated' : 'app'], { stdio: ['pipe','pipe','ignore'] });
    const session = ++this.generation;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stdin.on('error', () => child.kill());
    lines.on('line', line => {
      if (this.child !== child) return;
      let row;
      try { if (line.length > 65536) throw Error(); row = JSON.parse(line); } catch { child.kill(); return; }
      if (row.type === 'reply') {
        const pending = this.pending.get(row.id);
        if (pending) { this.pending.delete(row.id); clearTimeout(pending.timer); pending.resolve(row.value); }
      } else if (['status','reset','element'].includes(row.type)) {
        row.session = session;
        if (row.type === 'status') this.status = row;
        this.publish(row);
      }
    });
    const lost = () => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ error: 'Paddle disconnected.' }); }
      this.pending.clear();
      this.publish({ type: 'reset' });
      this.status = { type: 'status', phase: 'waiting', detail: 'Paddle engine disconnected. Listening and keyboard practice are available.' };
      this.publish(this.status);
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 2500);
    };
    child.once('error', lost);
    child.once('exit', lost);
    if (this.input !== 'off') void this.command('input', this.input);
  }
  command(op, value) {
    if (!validCommand(op,value)) return Promise.resolve({ error: 'Invalid paddle command.' });
    if (op === 'input') this.input = value;
    if (op === 'vband' && (this.input !== 'vband' || value.session !== this.generation)) return Promise.resolve({ error: 'VBand input was interrupted.' });
    if (!this.child) return Promise.resolve({ error: 'Paddle unavailable.' });
    const starting = this.status?.session !== this.generation;
    if (starting && ['arm','vband','calibrate','sample'].includes(op))
      return Promise.resolve({ error: 'Paddle engine is starting. Release both paddles and try again.' });
    if (this.pending.size >= 32) {
      if (!['input','vband-release','disarm','interrupt'].includes(op)) return Promise.resolve({ error: 'Paddle command unavailable.' });
      // Terminating the engine releases all contacts and any typing destination.
      this.child.kill();
      return Promise.resolve({ error: 'Paddle input was interrupted.' });
    }
    const child = this.child, id = ++this.serial;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: 'Paddle command timed out.' }); child.kill(); }, starting ? 15000 : 2500);
      this.pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ id, op, value }) + '\n');
    });
  }
  stop() {
    this.stopped = true; clearTimeout(this.retry);
    const child = this.child;
    if (!child) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
