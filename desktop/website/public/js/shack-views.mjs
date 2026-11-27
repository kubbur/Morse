import { slots, tiers, items, equipment, assembled, receiving, stationTier, balances, cost, frequency, badgePrice, SLOW_CW_CALLING_KHZ, speedGroups, speedGroup, paceLabel, qslCount, QSL_XP } from './shack-model.mjs';
import { operatorBadges, validAchievements } from './operator-achievements.mjs';
import { COURSE_LEVELS } from './lessons.mjs';
import { SENDING_LEVELS } from './sending-course.mjs';
export const esc = v => String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => n.toLocaleString();
export const button = (label, action, attrs='', type='quiet') => `<button type="button" class="${type}" data-act="${action}" ${attrs}>${esc(label)}</button>`;
export const paddleControls = `<div class="shack-paddles" role="group" aria-label="On-screen paddles" hidden>
  <button type="button" class="quiet" data-shack-paddle="dit">Dot</button>
  <button type="button" class="quiet" data-shack-paddle="dah">Dash</button></div>`;
const portrait = item => `<canvas width="144" height="72" data-portrait="${item.id}" aria-hidden="true"></canvas>`;
export const tabs = new Map([['air','On air'],['bench','Workbench'],['shop','Shop'],['log','Logbook']]);
const tabIcons = {
  air:'<rect x="2.5" y="6" width="19" height="14" rx="2"/><path d="m5 6 12-4M6 10h8m-8 4h6"/><circle cx="17.5" cy="14" r="2"/>',
  bench:'<path d="M3 12h18v5H3zm2 5v4m14-4v4M7 12V7l3-3 2 2-3 3v3m7 0V5h2v7"/>',
  shop:'<path d="M3 10l2-6h14l2 6M4 10v10h16V10M3 10q2 4 5 0 2 4 4 0 2 4 4 0 3 4 5 0M8 20v-6h5v6"/>',
  log:'<path d="M4 4h13a2 2 0 0 1 2 2v15H6a2 2 0 0 1-2-2zm0 13h15M8 8h7m-7 4h5"/>',
};
export function heading(ui) {
  const station=assembled(ui.s) ? stationTier(ui.s)+' station' : receiving(ui.s) ? 'Receive-only station' : 'Station under construction';
  return `<div class="hero"><div><p class="kicker">Virtual 40 m band</p><h1>The Shack</h1></div>
    <button type="button" class="callout profile-call" data-act="profile" aria-haspopup="dialog" aria-controls="operator-profile-dialog" aria-label="My profile, ${esc(ui.call)}">
      <span class="label">${station}</span><strong>${esc(ui.call)}</strong><small>My profile</small></button></div>
    <div class="shack-nav"><nav class="tabs" aria-label="The Shack">${[...tabs].map(([id,label])=>
      `<button type="button" data-act="tab" data-id="${id}" ${ui.tab===id?'aria-current="page"':''}><svg class="svg" viewBox="0 0 24 24" aria-hidden="true">${tabIcons[id]}</svg>${label}</button>`).join('')}</nav>
    ${button('← Progress','progress','','textbtn')}</div>`;
}
function activity(ui) {
  const rows=new Map(speedGroups.map(group=>[group.calling,group.name+' calling · '+paceLabel(group)]));
  for (const f of [...Object.keys(ui.band.activity || {}).map(Number),ui.f]) {
    if (!speedGroup(f)) rows.set(f,'Open frequency');
  }
  return [...rows].sort(([a],[b])=>a-b).map(([f,label])=>`<button type="button" class="activity ${f===ui.f?'selected':''}" data-act="tune" data-f="${f}">
    <span><span class="activityfreq">${frequency(f)} MHz</span><small>${label}</small></span>
    <span class="count" aria-label="${ui.band.state==='live' ? (ui.band.activity[f] || 0)+' operators' : 'Occupancy unavailable'}">${ui.band.state==='live' ? (ui.band.activity[f] || 0) : '—'}</span></button>`).join('');
}
export { activity };
function radioConsole(ui) {
  const rig=equipment(ui.s.equipped[1]?.id);
  if (!rig) {
    const owned=items.some(item=>item.slot===1 && ui.s.orders[item.id]);
    return `<section class="empty radio-empty"><h2>No radio equipped</h2><p>${owned ? 'Equip a radio from your inventory to go on air.' : 'Buy a radio in the Shop, then equip it in the Workbench.'}</p>
      ${owned ? button('Open Workbench','tab','data-id="bench"','quiet') : button('Shop radios','shop-radios','','quiet')}</section>`;
  }
  return `<div class="radio-console"><section class="instrument" data-rig="${rig.level}" aria-label="CW transceiver">
    <div class="facehead"><span class="label">∿ &nbsp; ${rig.name}</span><span class="tiny">1 kHz / step</span></div>
    <div class="face"><div class="lcd"><div class="lcd-top"><span class="lcd-state" data-face="mode">RX</span><span data-face="pace"></span></div>
    <div class="freqline"><strong class="frequency" data-face="frequency"></strong><span class="mhz">MHz</span></div>
    <div class="lcd-foot"><span data-face="room"></span><span class="relay-delay" title="Round-trip time to the live CW relay"><span data-face="delay"></span><span class="meter" aria-hidden="true">${'<i></i>'.repeat(11)}</span></span></div></div>
    <div class="knobgroup"><div class="knob" role="slider" tabindex="0" aria-label="Tuning knob in kilohertz" aria-valuemin="7020" aria-valuemax="7050"></div>
    <div class="tuneops">${button('−','step','data-step="-1" aria-label="Tune down 1 kHz"','mini')}${button('+','step','data-step="1" aria-label="Tune up 1 kHz"','mini')}</div></div></div>
    <div class="scale"><input type="range" data-dial aria-label="Tune frequency in kilohertz" min="7020" max="7050" step="1" value="${ui.f}">
    <div class="scale-labels">${[7020,7025,7030,7035,7040,7045,7050].map(f=>`<span>${frequency(f)}</span>`).join('')}</div></div>
    <div class="pitch-control"><div><span class="label">CW pitch</span><output data-face="pitch"></output></div>
    <div class="knob pitch-knob" role="slider" tabindex="0" aria-label="Receive and send tone" aria-valuemin="200" aria-valuemax="2000"></div>
    <div class="tuneops">${button('−','pitch-step','data-step="-50" aria-label="Lower CW pitch by 50 Hz"','mini')}${button('+','pitch-step','data-step="50" aria-label="Raise CW pitch by 50 Hz"','mini')}</div></div>
    <div class="transmit">${receiving(ui.s)?'':button(Object.keys(ui.s.orders).length?'Equip your station':'Get starter equipment','tab',`data-id="${Object.keys(ui.s.orders).length?'bench':'shop'}"`,'btn')}${button('Input settings','settings','aria-haspopup="dialog"','textbtn')}${button('Radio hiss','hiss',`aria-pressed="${ui.hiss === true}"`,'hiss-toggle')}</div>
    <p class="radio-note" data-face="note" role="status"></p></section>${paddleControls}</div>`;
}
export function air(ui) {
  return `<div class="radio-layout">${radioConsole(ui)}
    <aside class="card band"><div class="head"><h2>Band activity</h2><small class="tiny">Operators</small></div><div data-band>${activity(ui)}</div></aside></div>
    <div class="secondary-grid"><section class="card beacon-card"><span class="label">Beacon hunt</span><h2>Find Reykjavík</h2>
    <p class="panel-copy">Tune between 7.040–7.049 MHz. Copy RVK’s three-digit code to earn its QSL.</p>${button('Open hunt','hunt','','textbtn')}</section>
    <section class="card qsl-teaser"><div><span class="label">QSL wall</span><h2>${Object.keys(ui.s.cards).length?'Your QSL cards':'Your first contact'}</h2>
    <p class="panel-copy">${Object.keys(ui.s.cards).length?'Replay a signature as it was keyed.':'Key CQ on a frequency and listen for a reply.'}</p>
    ${button('Open logbook','tab','data-id="log"','textbtn')}</div><div class="ticket ticket-small" aria-hidden="true"><span>QSL / CW</span><b>73</b></div></section></div>`;
}
function gearItem(item, mounted) {
  return `<article class="kit" draggable="true" data-gear="${item.id}">
    <div class="portrait">${portrait(item)}</div><span class="label">${item.tier}</span><strong>${esc(item.name)}</strong>
    ${button(mounted?'Unequip':'Equip',mounted?'unequip':'equip',`data-id="${item.id}" aria-label="${mounted?'Unequip':'Equip'} ${esc(item.name)}"`,'textbtn')}</article>`;
}
export function bench(ui) {
  const s=ui.s, unmounted=items.filter(i=>s.orders[i.id] && s.equipped[i.slot]?.id!==i.id);
  return `<div class="bench-windows"><section class="card"><div class="head"><h2>Equipped</h2><span class="tiny">${s.equipped.filter(x=>x?.id).length} / 3 slots</span></div>
    <div class="mounts">${slots.map((name,i)=>{const item=equipment(s.equipped[i]?.id);
      return `<div class="mount" data-slot="${i}"><h3>${name}</h3>${item ? gearItem(item,true) : '<div class="empty-slot">Empty slot</div>'}</div>`;}).join('')}</div></section>
    <section class="card inventory" data-inventory><div class="head"><h2>Inventory</h2><span class="tiny">${unmounted.length} available</span></div>
    ${unmounted.length ? `<div class="inventory-grid">${unmounted.map(i=>gearItem(i,false)).join('')}</div>` :
      `<p class="empty-note">${Object.keys(s.orders).length?'Every owned item is equipped. Drop an item here to store it.':'Equipment you buy in the Shop appears here.'}</p>`}
    </section></div><p class="tiny bench-help">Drag an item to its slot, or use Equip. Drop equipped gear in Inventory to put it away.</p>`;
}
export function shop(ui) {
  const s=ui.s, {xp,credits}=balances(s,ui.xp(ui.p)), money=xp+credits;
  const payment = price => {
    const used=Math.min(price,credits), due=price-used;
    return [used && fmt(used)+' cr',due && fmt(due)+' XP'].filter(Boolean).join(' + ') || '0 XP';
  };
  const owned=items.filter(i=>i.slot===ui.slot && s.orders[i.id]);
  const shelf=items.filter(i=>i.slot===ui.slot).map(item=>{
    const bought=owned.includes(item), price=cost(s,item);
    return `<article class="kit shelf"><div class="portrait">${portrait(item)}</div><span class="label">${item.tier}</span><strong>${item.name}</strong>
      ${bought ? '<span class="tiny">Owned</span>' : button(price ? `Buy · ${payment(price)}` : 'Claim · 0 XP','buy',`data-id="${item.id}" ${price>money?'disabled':''}`,'mini')}</article>`;
  }).join('');
  const t=tiers.findIndex((_,level)=>items.some(i=>i.level===level && i.price>Math.max(0,...items.filter(j=>j.slot===i.slot && s.orders[j.id]).map(j=>j.price))));
  const bundle=t<0?[]:items.filter(i=>i.level===t && !s.orders[i.id] && cost(s,i)>0);
  const price=bundle.reduce((sum,i)=>sum+cost(s,i),0);
  const badges=ui.badges(ui.p);
  return `<div class="wallet"><section class="card"><span class="label">Current XP</span><strong>${fmt(xp)} XP</strong><small class="tiny">Your leaderboard score</small></section>
    <section class="card"><span class="label">Badge credits</span><strong>${fmt(credits)} cr</strong><small class="tiny">Applied first at checkout</small></section></div>
    ${bundle.length?`<section class="card bundle"><div><h2>${tiers[t][0]} station</h2><p class="tiny">${bundle.map(i=>i.name).join(' · ')}</p></div>
      ${button(`Buy set · ${payment(price)}`,'bundle',`data-tier="${t}" ${price>money?'disabled':''}`,'quiet')}</section>`:''}
    <section class="card"><div class="head"><h2>Equipment shop</h2><span class="tiny">Upgrades cost the difference</span></div>
    <nav class="tabs" aria-label="Shop categories">${slots.map((s,i)=>button(s,'category',`data-slot="${i}" ${ui.slot===i?'aria-current="page"':''}`,'')).join('')}</nav>
    <div class="inventory-grid">${shelf}</div></section>
    <section class="card badge-counter"><h2>Badge counter</h2><p class="panel-copy">Sell each badge once. Your achievement stays in Progress.</p>
    ${badges.map(b=>`<div class="sale"><strong>${esc(b.title)}</strong>${s.sold.includes(b.id)?'<span class="tiny">Sold</span>':button(`Sell · ${badgePrice(b.id)} cr`,'sell',`data-id="${esc(b.id)}"`,'mini')}</div>`).join('') || '<p class="tiny">Earn badges in Listen and Send.</p>'}</section>`;
}
export function logbook(ui) {
  const cards=Object.entries(ui.s.cards).sort((a,b)=>b[1].at-a[1].at);
  const count=qslCount(ui.s);
  return `<div class="head"><h2>Contact log &amp; QSL wall</h2><span class="tiny">${fmt(count)} collected · ${count ? fmt(count*QSL_XP)+' XP earned' : QSL_XP+' XP per card'}</span></div>
    ${cards.length ? `<div class="record-grid">${cards.map(([id,c])=>{
      const stamp=new Date(c.at).toISOString();
      return `<article class="card"><div class="ticket ticket-full ${c.beacon?'':'remote'}"><span class="ticket-header">${c.beacon?'BEACON QSL':'TWO-WAY CW'}</span><b>${esc(c.from)}</b><span class="ticket-foot">${frequency(c.f)} MHz · ${c.beacon?'Reykjavík':'To '+esc(ui.call)}</span></div>
        <div class="ticket-body"><p class="tiny">${stamp.slice(0,10)} · ${stamp.slice(11,16)} UTC</p><div class="actions">
        ${button('Play card','play',`data-id="${id}" ${c.audio?'':'disabled'}`,'mini')}${c.beacon?'':c.mine?button('Play my signature','mine',`data-id="${id}"`,'mini'):button('Sign return QSL','sign',`data-id="${id}"`,'mini')}</div></div></article>`;
    }).join('')}</div>` : `<section class="empty"><strong>Your wall is ready for its first card.</strong><p class="panel-copy">Make a two-way contact or copy the Reykjavík beacon.</p>${button('Tune Slow CW','tune',`data-f="${SLOW_CW_CALLING_KHZ}"`)}</section>`}`;
}
export function operatorProfile({callsign,xp,lifetimeXP,equipped,achievements}) {
  const trophies = validAchievements(achievements);
  return `<p class="operator-call">${esc(callsign)}</p>
    <div class="operator-xp"><div><span>Current XP</span><strong>${fmt(xp)}</strong></div>
    <div><span>All-time earned XP</span><strong>${fmt(lifetimeXP)}</strong></div></div>
    ${trophies ? `<dl class="operator-milestones">
      <div><dt>Listen levels cleared</dt><dd>${achievements.listen}<small> / ${COURSE_LEVELS}</small></dd></div>
      <div><dt>Send levels cleared</dt><dd>${achievements.send}<small> / ${SENDING_LEVELS}</small></dd></div>
      <div><dt>QSL cards</dt><dd>${fmt(achievements.qsls)}<small> · ${fmt(achievements.qsls*QSL_XP)} XP</small></dd></div></dl>` : ''}
    <h3>Equipped station</h3><div class="operator-gear">${slots.map((slot,index)=>{
      const item=equipment(equipped?.[index]);
      return `<div><span>${slot}</span>${item ? portrait(item) : ''}<strong>${item ? esc(item.name) : 'Empty slot'}</strong></div>`;
    }).join('')}</div>
    ${trophies ? `<section class="operator-awards"><h3>Badge cabinet <small>${achievements.badges.length} earned</small></h3>
      ${achievements.badges.length ? `<ul>${achievements.badges.map(id=>{
        const badge=operatorBadges.get(id);
        return `<li><span class="badge-symbol"><svg class="icon" aria-hidden="true"><use href="#i-${badge.icon}"/></svg></span><div><strong>${esc(badge.title)}</strong><small>${esc(badge.description)}</small></div></li>`;
      }).join('')}</ul>` : '<p class="muted small-copy">Earn badges by practising Listen and Send.</p>'}</section>` : ''}`;
}
