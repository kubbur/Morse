// Visual rewards share the listening room's reserved space. They never open a
// dialog, take focus, add audio or delay the next training signal.
export class RewardEffects {
  constructor(layer, announcement, receiver) {
    this.layer = layer;
    this.announcement = announcement;
    this.receiver = receiver;
    this.timer = null;
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.layer.hidden = true;
    this.layer.replaceChildren();
    delete this.receiver.dataset.reward;
  }

  show({ kind = 'badge', title, detail = '', icon = 'spark', badges = [] }) {
    this.clear();
    const make = (tag, className, text) => {
      const element = document.createElement(tag);
      element.className = className;
      if (text) element.textContent = text;
      return element;
    };
    const particles = make('div', 'reward-particles');
    for (let i = 0; i < 24; i++) {
      const spark = make('i', 'reward-particle');
      const angle = i * Math.PI * 2 / 24;
      const distance = (i % 3 + 2) * 22;
      spark.style.setProperty('--spark-x', `${Math.cos(angle) * distance}px`);
      spark.style.setProperty('--spark-y', `${Math.sin(angle) * distance}px`);
      spark.style.setProperty('--spark-turn', `${i * 37}deg`);
      spark.style.setProperty('--spark-delay', `${i % 4 * 25}ms`);
      particles.append(spark);
    }
    const medallion = make('span', 'reward-medallion');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('icon');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', `#i-${icon}`);
    svg.append(use); medallion.append(svg);
    const copy = make('div', 'reward-copy');
    if (kind === 'badge') copy.append(make('span', 'reward-eyebrow', badges.length > 1 ? `${badges.length} badges earned` : 'Badge earned'));
    copy.append(make('strong', 'reward-title', title));
    if (detail) copy.append(make('span', 'reward-detail', detail));
    const card = make('div', 'reward-card');
    card.append(medallion, copy);
    this.layer.dataset.kind = kind;
    this.layer.append(particles, card);
    this.layer.hidden = false;
    this.receiver.dataset.reward = kind;
    this.announcement.textContent = `${title}. ${detail}`;
    this.timer = setTimeout(() => this.clear(), kind === 'badge' ? 850 : 1600);
  }
}
