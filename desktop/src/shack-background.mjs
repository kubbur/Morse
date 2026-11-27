import { paddleCharacter } from '../website/public/js/keyboard-paddles.mjs';

export function validShackKeys(keys) {
  return keys && ['keyboard','straight','vband'].includes(keys.source) &&
    paddleCharacter(keys.dit)===keys.dit && !!keys.dit && paddleCharacter(keys.dah)===keys.dah && !!keys.dah && keys.dit!==keys.dah;
}

// Native events from an earlier tab, keyboard layout choice or focus interval cannot key a new station.
export class ShackBackground {
  constructor({command,notify,throttle}) {
    Object.assign(this,{command,notify,throttle});
    this.focused=true; this.available=false; this.epoch=0;
  }
  configure(state) {
    if (state && (typeof state.listening!=='boolean' || !Number.isSafeInteger(state.generation) ||
        state.keys!==null && (!state.listening || !validShackKeys(state.keys)))) return;
    const wasListening=!!this.state?.listening;
    this.state=state;
    if (wasListening!==!!state?.listening) this.throttle(!state?.listening);
    this.refresh();
  }
  refresh() {
    const next=this.available && !this.focused && !this.locked && !this.sleeping && this.state?.keys ? this.state : null;
    if ((this.armed ?? null)===next) return;
    const previous=this.armed;
    this.armed=next;
    const epoch=++this.epoch;
    if (previous) this.notify({generation:previous.generation,reset:true});
    if (!this.available) return;
    void this.command('shack-keys',next ? {...next.keys,epoch} : null).then(reply=>{
      if (this.epoch===epoch && next && reply?.error) this.notify({generation:next.generation,error:reply.error});
    });
  }
  contact(row) {
    if (!this.armed || row.epoch!==this.epoch) return;
    this.notify({generation:this.armed.generation,mask:row.mask,at:row.at,reset:row.reset,error:row.error});
  }
}
