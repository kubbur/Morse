import { LETTERS, DIGITS } from './morse.mjs';

export const alphabet = LETTERS + DIGITS;
export const slots = ['Morse key', 'Radio', 'Antenna'];
export const tiers = [
  ['Starter', [50, 150, 100], ['Straight key', 'Used QRP radio', 'Wire dipole']],
  ['Club', [100, 500, 200], ['Portable straight key', 'Club transceiver', 'Linked dipole']],
  ['Full band', [150, 1000, 350], ['Twin-lever paddle', 'Multiband CW rig', 'End-fed wire']],
  ['Field', [500, 3000, 1500], ['Travel paddle', 'Field QRP rig', 'Packable vertical']],
  ['Home', [2500, 15000, 7500], ['Precision paddle', 'Base transceiver', 'Roof-mounted beam']],
  ['Dream', [10000, 60000, 30000], ['Hand-finished paddle', 'Flagship transceiver', 'Tower-mounted array']],
];
export const items = tiers.flatMap(([tier, prices, names], level) =>
  names.map((name, slot) => ({ id: `${slot}-${level}`, slot, level, tier, price: prices[slot], name })));
const catalog = new Map(items.map(item => [item.id, item]));
export const equipment = id => catalog.get(id);
export const rooms = new Map([[7025,'Slow CW'],[7030,'Calling frequency'],[7032,'Club room'],[7035,'Ragchew'],[7038,'Open frequency']]);
export const frequency = f => (f / 1000).toFixed(3);
export const validFrequency = f => Number.isInteger(f) && f >= 7020 && f <= 7050;
export const badgePrice = id => id === 'send-first' ? 35 : id === 'send-ten' ? 75 : 25;
const symbols = text => [...alphabet].filter(c => typeof text === 'string' && text.includes(c)).join('');
const time = n => Number.isSafeInteger(n) && n > 0 && n <= 8640000000000000 ? n : 0;
const entries = value => Object.entries(value && typeof value === 'object' ? value : {});
const call = value => typeof value === 'string' && /^[A-Z0-9/]{2,16}$/.test(value);
export const validRhythm = a => Array.isArray(a) && a.length >= 1 && a.length <= 160 && a.every(p =>
  Array.isArray(p) && p.length === 2 && Number.isInteger(p[0]) && p[0] >= 8 && p[0] <= 10000 &&
  Number.isInteger(p[1]) && p[1] >= 0 && p[1] <= 15000) && a.reduce((n,[d,g])=>n+d+g,0) <= 120000;
// Old saves recorded badge sales without dates. Their proceeds were available in the old wallet.
// Replay receipts in time order so selling a badge today cannot refund XP spent yesterday.
function ledger(s, orders = s?.orders) {
  const accepted = {}, high = [0,0,0];
  const sales = (s?.sold || []).map(id => ({at:time(s?.soldAt?.[id]), amount:badgePrice(id)})).sort((a,b)=>a.at-b.at);
  const totalCredit = sales.reduce((sum,sale)=>sum+sale.amount,0);
  let issued = 0, used = 0, spent = 0, nextSale = 0;
  const chronological = entries(orders).filter(([id,at])=>catalog.has(id) && time(at))
    .sort((a,b)=>a[1]-b[1] || a[0].localeCompare(b[0]));
  for (const [id,at] of chronological) {
    while (nextSale < sales.length && sales[nextSale].at <= at) issued += sales[nextSale++].amount;
    const item = catalog.get(id), price = Math.max(0,item.price-high[item.slot]);
    const credit = Math.min(price,issued-used), xp = price-credit;
    if (spent+xp > s.converted) continue;
    accepted[id] = at;
    high[item.slot] += price;
    used += credit;
    spent += xp;
  }
  return {orders:accepted, spent, credits:totalCredit-used};
}
export function balances(s, lifetime) {
  const {spent,credits} = ledger(s);
  return {xp:Math.max(0,lifetime-spent), credits, spent};
}
export function sanitizeShack(raw = {}) {
  const converted = Math.max(0, Math.min(1e9, Math.floor(Number(raw?.converted) || 0)));
  const sold = [...new Set(Array.isArray(raw?.sold) ? raw.sold.filter(s => typeof s === 'string' && /^[a-z0-9-]{1,60}$/.test(s)).slice(0,240) : [])].sort();
  const state = { converted, sold, orders: {}, equipped: [null,null,null], copied: symbols(raw?.copied), sent: symbols(raw?.sent), cards: {} };
  state.soldAt = Object.fromEntries(sold.filter(id=>time(raw?.soldAt?.[id])).map(id=>[id,raw.soldAt[id]]));
  state.orders = ledger(state, raw?.orders).orders;
  state.equipped = slots.map((_, slot) => {
    const selection = raw?.equipped?.[slot];
    if (!time(selection?.at)) return null;
    return { id: state.orders[selection.id] && catalog.get(selection.id)?.slot === slot ? selection.id : '', at: selection.at };
  });
  for (const [id, c] of entries(raw?.cards).filter(([id,c]) => /^[\w-]{1,80}$/.test(id) && c && time(c.at) && call(c.from) && validFrequency(c.f)).sort((a,b)=>b[1].at-a[1].at || a[0].localeCompare(b[0])).slice(0,80)) {
    state.cards[id] = { at:c.at, from:c.from, f:c.f, beacon:c.beacon === true,
      ...(validRhythm(c.audio) ? {audio:c.audio} : {}), ...(validRhythm(c.mine) ? {mine:c.mine} : {}) };
  }
  return state;
}
export function mergeShack(a,b) {
  const left = sanitizeShack(a), right = sanitizeShack(b);
  const orders = {...left.orders}, cards = {...left.cards};
  for (const [id,at] of entries(right.orders)) orders[id] = Math.min(orders[id] || at, at);
  for (const [id,card] of entries(right.cards)) cards[id] = {...cards[id], ...card};
  const equipped = slots.map((_,i) => [left.equipped[i],right.equipped[i]].filter(Boolean)
    .sort((x,y) => y.at-x.at || x.id.localeCompare(y.id))[0]);
  const soldAt = {...left.soldAt};
  for (const id of right.sold) soldAt[id] = left.sold.includes(id)
    ? Math.min(left.soldAt[id] || 0,right.soldAt[id] || 0) : right.soldAt[id];
  return sanitizeShack({ converted:Math.max(left.converted,right.converted), sold:[...left.sold,...right.sold], soldAt, orders,equipped,cards,
    copied:left.copied+right.copied, sent:left.sent+right.sent });
}
export function highestPrice(s,slot) {
  return Math.max(0,...items.filter(i => i.slot === slot && s.orders[i.id]).map(i => i.price));
}
export const invested = s => slots.reduce((n,_,slot) => n + highestPrice(s,slot),0);
export const installed = s => slots.reduce((n,_,i)=>n+(equipment(s?.equipped?.[i]?.id)?.price || 0),0);
export const receiving = s => !!(s?.equipped?.[1]?.id && s?.equipped?.[2]?.id);
export const stationTier = s => tiers.filter(([,prices])=>installed(s)>=prices.reduce((a,b)=>a+b,0)).at(-1)?.[0];
export function equipmentSnapshot(s) {
  if (!s || !Object.keys(s.orders).length) return null;
  const {orders,equipped,sold,soldAt} = s;
  return {converted:Math.min(s.converted,100000), orders,equipped,sold,soldAt:soldAt || {}};
}
export function wallet(s, lifetime=s.converted) {
  const {xp,credits} = balances(s,lifetime);
  return xp+credits;
}
export const cost = (s,item) => Math.max(0,item.price-highestPrice(s,item.slot));
function nextReceipt(s,at) {
  return Math.max(at,1+Math.max(0,...Object.values(s.orders),...Object.values(s.soldAt || {})));
}
export function sellBadge(s,id,at=Date.now()) {
  if (s.sold.includes(id)) return false;
  const stamp=nextReceipt(s,at);
  s.sold.push(id);
  (s.soldAt ||= {})[id]=stamp;
  return true;
}
export function purchase(s, ids, at = Date.now(), lifetime=s.converted) {
  if (!Array.isArray(ids) || !ids.length || !time(at) || !Number.isSafeInteger(lifetime) || lifetime<0 || lifetime>1e9) return false;
  const order = ids.map(equipment);
  if (order.some(i=>!i) || new Set(order.map(i=>i.slot)).size !== order.length) return false;
  if (order.reduce((n,i)=>n+cost(s,i),0) > wallet(s,lifetime)) return false;
  s.converted = Math.max(s.converted,lifetime);
  const stamp=nextReceipt(s,at);
  for (const item of order) s.orders[item.id] ||= stamp;
  return true;
}
export function equip(s, id, slot, at = Date.now()) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length || (id && (!s.orders[id] || equipment(id)?.slot !== slot))) return false;
  s.equipped[slot] = { id, at:Math.max(at,(s.equipped[slot]?.at || 0)+1) };
  return true;
}
export const assembled = s => slots.every((_,slot)=>!!s.equipped[slot]?.id);
export const minimumStation = f => f===7025 ? 300 : [7030,7032,7035].includes(f) ? 800 : 1500;
export function coverage(p) {
  const s = p.shack || {};
  return { copied:symbols((s.copied || '') + [...alphabet].filter(c=>p.stats.characters[c]?.correct > 0).join('')),
    sent:symbols((s.sent || '') + [...alphabet].filter(c=>p.sending.sounds[c]?.good > 0).join('')) };
}
export const qualified = p => Object.values(coverage(p)).every(c=>c.length === alphabet.length);
export const qualificationCredit = '6a081eff-dacd-4af8-b2ff-564348534143';
export function certify(p) {
  if (!qualified(p) || p.credits[qualificationCredit]) return false;
  p.credits[qualificationCredit] = 300;
  p.stats.xp = Math.min(1e9, p.stats.xp + 300);
  return true;
}
export function canTransmit(f, value, passed) {
  return validFrequency(f) && value>=minimumStation(f) && (f===7025 || passed);
}
export function hunt(date = new Date()) {
  const day = date.toISOString().slice(0,10), seed = Math.floor(Date.parse(day)/86400000);
  return { day, f:7040+(seed*7+3)%10, pin:String(100+(seed*37+113)%900) };
}
