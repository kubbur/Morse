import { MorseAudio as WebsiteAudio } from './js/website-audio.mjs';
import { timeline } from './js/morse.mjs';

export class MorseAudio extends WebsiteAudio {
  async unlock() {
    if (!globalThis.morsePhone?.wired) return super.unlock();
  }
  async play(text, settings, options = {}) {
    this.stop();
    const phone = globalThis.morsePhone;
    if (!phone?.wired) return super.play(text,settings,options);
    const id = crypto.randomUUID(), plan = timeline(text,settings);
    this.phoneID = id;
    const unsubscribe = phone.onPromptStart(id, elapsed => {
      const started = performance.now() - 1000 * elapsed;
      options.onSchedule?.(plan,started,() => (performance.now()-started)/1000);
    });
    try {
      const reply = await phone.post({op:'prompt',id,tones:plan.tones.map(({start,duration}) => ({start,duration})),
        settings:{tone:settings.tone,volume:settings.volume,rise:settings.rise,fall:settings.fall,curve:settings.curve}});
      if (reply.error) throw Error(reply.error);
      return {completed:!!reply.completed};
    } finally {
      unsubscribe();
      if (this.phoneID === id) this.phoneID = null;
    }
  }
  stop() {
    const id = this.phoneID;
    this.phoneID = null;
    if (id) void globalThis.morsePhone.post({op:'stopPrompt',id}).catch(() => {});
    super.stop();
  }
}
