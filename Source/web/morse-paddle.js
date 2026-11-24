// Add <morse-paddle-input> and listen for its bubbling "paddlechange" event.
// Both contacts are reported together so squeezes and releases stay unambiguous.
export const paddleEndpoint = "http://127.0.0.1:17373/events";

let pendingSidetoneCommand = Promise.resolve();
export function setSidetoneMuted(muted) {
  if (typeof muted !== "boolean") return Promise.reject(new TypeError("Expected a boolean mute state"));
  const url = new URL(muted ? "/sidetone/mute" : "/sidetone/unmute", paddleEndpoint);
  const command = pendingSidetoneCommand.then(async () => {
    const response = await fetch(url, {method: "PUT", credentials: "omit"});
    if (!response.ok) throw new Error(`Morse Paddle returned HTTP ${response.status}`);
  });
  // Keep quick mute / unmute calls in order, including after a failed request.
  pendingSidetoneCommand = command.catch(() => {});
  return command;
}

export class MorsePaddle extends EventTarget {
  #source = null;
  #watchdog = null;
  #wanted = false;
  #lastSequence = -1;
  #visibility = () => {
    if (document.hidden) this.#close("paused");
    else if (this.#wanted) this.#open();
  };
  #pageHide = () => this.#close("paused");
  #pageShow = () => { if (this.#wanted && !document.hidden) this.#open(); };
  state = Object.freeze({status: "disconnected", dit: false, dah: false, seq: null, timeMs: null, wpm: 30, effectiveWpm: 30});

  connect() {
    if (this.#wanted) return;
    this.#wanted = true;
    document.addEventListener("visibilitychange", this.#visibility);
    window.addEventListener("pagehide", this.#pageHide);
    window.addEventListener("pageshow", this.#pageShow);
    if (!document.hidden) this.#open();
  }
  disconnect() {
    this.#wanted = false;
    document.removeEventListener("visibilitychange", this.#visibility);
    window.removeEventListener("pagehide", this.#pageHide);
    window.removeEventListener("pageshow", this.#pageShow);
    this.#close("disconnected");
  }
  #update(status, dit = false, dah = false, seq = null, timeMs = null, wpm = this.state.wpm, effectiveWpm = this.state.effectiveWpm) {
    const previous = this.state;
    this.state = Object.freeze({status, dit, dah, seq, timeMs, wpm, effectiveWpm});
    if (status !== previous.status || dit !== previous.dit || dah !== previous.dah ||
        wpm !== previous.wpm || effectiveWpm !== previous.effectiveWpm) {
      this.dispatchEvent(new CustomEvent("paddlechange", {detail: this.state}));
    }
  }
  #arm(source) {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      if (this.#source !== source) return;
      this.#close("reconnecting");
      if (this.#wanted && !document.hidden) this.#open();
    }, 6000);
  }
  #open() {
    if (this.#source) return;
    this.#lastSequence = -1;
    this.#update("connecting");
    let source;
    try { source = new EventSource(paddleEndpoint); }
    catch { this.#update("unavailable"); return; }
    this.#source = source;
    source.onopen = () => {
      if (this.#source === source) { this.#lastSequence = -1; this.#arm(source); }
    };
    source.addEventListener("heartbeat", () => { if (this.#source === source) this.#arm(source); });
    source.addEventListener("reset", () => {
      if (this.#source === source) { this.#lastSequence = -1; this.#update("reconnecting"); }
    });
    source.addEventListener("paddle", event => {
      if (this.#source !== source) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (!data || data.v !== 1 || !Number.isSafeInteger(data.seq) || data.seq <= this.#lastSequence ||
          typeof data.status !== "string" || typeof data.dit !== "boolean" || typeof data.dah !== "boolean" ||
          !Number.isFinite(data.timeMs)) return;
      this.#lastSequence = data.seq;
      this.#arm(source);
      const wpm = Number.isInteger(data.wpm) && data.wpm >= 5 && data.wpm <= 60 ? data.wpm : 30;
      const effective = Number.isInteger(data.effectiveWpm) && data.effectiveWpm >= 5 && data.effectiveWpm <= wpm ? data.effectiveWpm : wpm;
      this.#update(data.status, data.status === "ready" && data.dit, data.status === "ready" && data.dah, data.seq, data.timeMs, wpm, effective);
    });
    source.onerror = () => {
      if (this.#source !== source) return;
      this.#lastSequence = -1;
      this.#update("reconnecting");
      // A denied CORS/loopback request may close the EventSource permanently.
      this.#arm(source);
    };
  }
  #close(status) {
    const source = this.#source;
    this.#source = null;
    if (source) source.close();
    clearTimeout(this.#watchdog);
    this.#lastSequence = -1;
    this.#update(status);
  }
}

const messages = {
  disconnected: "Disconnected", connecting: "Connecting…", reconnecting: "Waiting for the Mac app…",
  waiting: "Plug in the paddle adapter", permission: "Allow microphone access on the Mac",
  calibrating: "Release both paddles…", ready: "Paddle ready", paused: "Paused", error: "Check the Mac app",
  unavailable: "Connection unavailable"
};

class MorsePaddleInput extends HTMLElement {
  receiver = new MorsePaddle();
  #connected = false;
  constructor() {
    super();
    const shadow = this.attachShadow({mode: "open"});
    const button = document.createElement("button");
    button.type = "button"; button.setAttribute("part","button"); button.textContent = "Connect paddle";
    const status = document.createElement("span");
    status.setAttribute("part","status"); status.setAttribute("role","status"); status.textContent = "Disconnected";
    shadow.append(button,document.createTextNode(" "),status);
    this.receiver.addEventListener("paddlechange", ({detail}) => {
      const label = messages[detail.status] || detail.status;
      if (status.textContent !== label) status.textContent = label;
      this.dispatchEvent(new CustomEvent("paddlechange",{detail,bubbles:true,composed:true}));
    });
    button.addEventListener("click", () => {
      this.#connected = !this.#connected;
      button.textContent = this.#connected ? "Disconnect" : "Connect paddle";
      if (this.#connected) this.receiver.connect(); else this.receiver.disconnect();
    });
  }
  disconnectedCallback() {
    this.#connected = false;
    this.receiver.disconnect();
    this.shadowRoot.querySelector("button").textContent = "Connect paddle";
  }
}
if (!customElements.get("morse-paddle-input")) customElements.define("morse-paddle-input",MorsePaddleInput);
