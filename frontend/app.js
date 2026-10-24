// The Nutritionist web: app logic and pages.
// Load order in index.html: config.js, data.js, api.js, auth.js, app.js

// ---------- Small helpers ----------
const DAY = 86400000;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = v => v !== null && v !== undefined && v !== '';
const sum = (list, key) => list.reduce((total, m) => total + (+m[key] || 0), 0);
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const dash = v => has(v) ? v : '–';
const dateLabel = t => new Date(t).toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });

function md(text) {
  const lines = esc(text).split(/\n/);
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, '$1<i>$2</i>');
    const item = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (item) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${item[1]}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

let toastTimer;
function toast(text) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

// ---------- State (saved per person in localStorage) ----------
const DEFAULT_PROFILE = { name: '', age: 20, sex: 'other', weight: 65, height: 170, activity: 'light', goal: 2000, goalDir: 'maintain', diet: 'Vegetarian', kitchen: 'burner', skin: '' };
let state;
let scan = { file: null, url: '', mode: 'meal', result: null, chat: [], added: false, busy: false };
let cook = { pantry: '', results: null, busy: false, focus: '' };
let ui = { histFilter: 'all' };

const storeKey = () => 'smf:' + authUid();

// Every account (guest or not) starts empty: no sample meals.
function emptyState() {
  return { v: 2, sample: false, profile: { ...DEFAULT_PROFILE }, startedOn: Date.now(), badges: {}, claims: [], stats: { labelScans: 0, mealScans: 0 }, profileTouched: false, meals: [] };
}

// Removes the sample meals and everything that was earned from them.
function dropSample(startedOn) {
  state.meals = state.meals.filter(m => !m.sample);
  state.sample = false; state.badges = {}; state.claims = [];
  state.startedOn = startedOn;
}

function loadState() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(storeKey())); } catch { raw = null; }
  state = raw || emptyState();
  state.profile = { ...DEFAULT_PROFILE, ...state.profile };
  state.badges = state.badges || {};
  state.claims = state.claims || [];
  state.stats = { labelScans: 0, mealScans: 0, ...state.stats };
  state.meals = state.meals || [];
  state.startedOn = state.startedOn || Date.now();
}

function save() {
  try { localStorage.setItem(storeKey(), JSON.stringify(state)); }
  catch { toast('Could not save on this device. Storage may be full or blocked.'); }
}

// ---------- Derived numbers ----------
const todayMeals = () => state.meals.filter(m => sameDay(m.at, Date.now()));
const weekMeals = () => state.meals.filter(m => m.at >= Date.now() - 7 * DAY);
const lastStreetAt = () => state.meals.filter(m => m.street).reduce((latest, m) => Math.max(latest, m.at), 0);
const runStart = () => Math.max(lastStreetAt(), state.startedOn);
const streakDays = () => Math.max(0, Math.floor((Date.now() - runStart()) / DAY));

function bestStreak() {
  const marks = [state.startedOn, ...state.meals.filter(m => m.street && m.at >= state.startedOn).map(m => m.at), Date.now()].sort((a, b) => a - b);
  let best = 0;
  for (let i = 1; i < marks.length; i++) best = Math.max(best, Math.floor((marks[i] - marks[i - 1]) / DAY));
  return best;
}

// Completed calendar days since the start with no street meal logged.
function streetFreeDays() {
  let n = 0;
  const day = new Date(state.startedOn); day.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(0, 0, 0, 0);
  for (; day < end; day.setDate(day.getDate() + 1)) if (!state.meals.some(m => m.street && sameDay(m.at, day))) n++;
  return n;
}

const homeCount = () => state.meals.filter(m => m.home).length;
const points = () => streetFreeDays() * 10 + homeCount() * 5 + state.claims.length * 50;
function level(pts) {
  const n = Math.floor(pts / 100) + 1;
  return { n, name: LEVELS[Math.min(n - 1, LEVELS.length - 1)], into: pts % 100 };
}
const claimable = () => Math.floor(streakDays() / 7) > state.claims.filter(t => t >= runStart()).length;
const badgeCtx = () => ({ streak: streakDays(), home: homeCount(), labelScans: state.stats.labelScans });

function checkBadges(silent) {
  const ctx = badgeCtx();
  BADGES.forEach(b => {
    if (!state.badges[b.id] && b.test(ctx)) {
      state.badges[b.id] = Date.now();
      if (!silent) toast(`Badge unlocked: ${b.name}`);
    }
  });
  save();
}

function targets() {
  const p = state.profile, goal = +p.goal;
  return { cal: goal, protein: Math.max(45, Math.round(p.weight * 0.8)), carbs: Math.round(goal * 0.5 / 4), fat: Math.round(goal * 0.3 / 9) };
}

// ---------- Live insights and body impact ----------
function insights(today) {
  const tg = targets(), out = [];
  const cal = sum(today, 'cal');
  const known = key => today.filter(m => has(m[key]));
  if (!today.length) out.push({ tone: 'info', text: 'Nothing logged today. Scan your first meal to get feedback.' });
  if (today.some(m => m.street)) out.push({ tone: 'warn', text: 'You had street food today, so your streak restarts. Make the next meal vegetables and protein, and try a home swap tomorrow.' });
  if (cal > tg.cal) out.push({ tone: 'warn', text: `You are ${Math.round(cal - tg.cal)} kcal over your goal for today. Keep the rest of the day to fruit, curd or salad.` });
  else if (cal > tg.cal * 0.9) out.push({ tone: 'info', text: 'You are close to your calorie goal for the day. Choose something light for the rest of it.' });
  if (known('sodium').length && sum(today, 'sodium') > 2000) out.push({ tone: 'warn', text: `Sodium is at ${Math.round(sum(today, 'sodium'))} mg today, past the 2000 mg daily limit. Skip packaged snacks and pickles, and drink water.` });
  if (today.length >= 2 && known('fibre').length && sum(today, 'fibre') < 10) out.push({ tone: 'info', text: 'Fibre is low so far. Add a salad, a fruit or a bowl of dal to help your gut.' });
  if (today.length && cal >= tg.cal * 0.5 && sum(today, 'protein') < tg.protein * 0.5) out.push({ tone: 'info', text: 'Protein is low for this point in the day. Dal, curd, paneer, eggs or sprouts would help.' });
  const streak = streakDays();
  if (!today.some(m => m.street) && streak >= 3 && streak < 7) out.push({ tone: 'good', text: `${7 - streak} more street-free days to your weekly reward.` });
  if (!out.length) out.push({ tone: 'good', text: 'Good day so far. Keep it up.' });
  const order = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]).slice(0, 3);
}

// A rough weekly read of what the logged food may be doing to four body systems.
// General guidance from thresholds (fibre 25 g, sodium 2000 mg, sugar 50 g a day), not a diagnosis.
function bodyImpact() {
  const w = weekMeals();
  if (w.length < 3) return null;
  const days = new Set(w.map(m => new Date(m.at).toDateString())).size;
  const avg = key => (w.filter(m => has(m[key])).length >= 3 ? sum(w.filter(m => has(m[key])), key) / days : null);
  const street = w.filter(m => m.street).length;
  const oily = w.filter(m => m.street || m.fat >= 20).length;
  const fibre = avg('fibre'), sodium = avg('sodium'), sugar = avg('sugar');

  let gut = fibre === null ? null : fibre < 15 ? 2 : fibre < 25 ? 1 : 0;
  let gutText = fibre === null ? 'Not enough fibre data yet.' : `Fibre averages ${Math.round(fibre)} g a day (aim for 25 g). Dal, vegetables, fruit and sprouts help.`;
  if (street >= 3) { gut = Math.max(gut ?? 0, 1); gutText += ` ${street} street meals this week also raise the chance of a stomach infection.`; }

  let skin = sugar === null ? (oily >= 3 ? 1 : null) : sugar > 50 ? 2 : sugar > 35 ? 1 : 0;
  if (oily >= 5) skin = 2; else if (oily >= 3) skin = Math.max(skin ?? 0, 1);
  const skinText = skin === null ? 'Not enough sugar data yet.' : `${sugar === null ? 'Sugar is unknown' : 'Sugar averages ' + Math.round(sugar) + ' g a day'}, with ${oily} oily or street meal${oily === 1 ? '' : 's'}. Very sugary and oily food is linked with more breakouts.`;

  const liver = oily >= 4 ? 2 : oily >= 2 ? 1 : 0;
  const liverText = `${oily} street or very oily meal${oily === 1 ? '' : 's'} this week. Reused frying oil at stalls is the main worry for your liver.`;

  const kidney = sodium === null ? null : sodium > 2300 ? 2 : sodium > 1800 ? 1 : 0;
  const kidneyText = sodium === null ? 'Not enough sodium data yet.' : `Sodium averages ${Math.round(sodium)} mg a day (limit about 2000 mg). Instant noodles, chips and pickles add up fast.`;

  return [
    { organ: 'Gut', level: gut, text: gutText }, { organ: 'Skin', level: skin, text: skinText },
    { organ: 'Liver', level: liver, text: liverText }, { organ: 'Kidneys', level: kidney, text: kidneyText },
  ];
}

// ---------- Pieces of UI ----------
function cell(label, value, goal, unit, tone) {
  const pct = Math.min(100, Math.round(value / goal * 100));
  return `<div class="cell ${value > goal ? 'over' : ''}" style="--fill:${pct}%;--tone:${tone}">
    <small>${label}</small><b>${Math.round(value)}${unit}</b><small>of ${goal}${unit}</small></div>`;
}

function weekChart() {
  const goal = +state.profile.goal;
  const days = [...Array(7)].map((_, i) => {
    const d = Date.now() - (6 - i) * DAY;
    const list = state.meals.filter(m => sameDay(m.at, d));
    return { label: new Date(d).toLocaleDateString('en', { weekday: 'short' }), cal: sum(list, 'cal'), street: list.some(m => m.street) };
  });
  const top = Math.max(goal, ...days.map(d => d.cal));
  const bars = days.map((d, i) => {
    const h = d.cal / top * 100;
    return `<rect x="${i * 50 + 8}" y="${110 - h}" width="34" height="${h}" rx="3" fill="${d.street ? 'var(--chili)' : 'var(--leaf)'}"><title>${d.label}: ${Math.round(d.cal)} kcal${d.street ? ', street food' : ''}</title></rect>
      <text x="${i * 50 + 25}" y="130" text-anchor="middle" font-size="11" fill="currentColor">${d.label}</text>`;
  }).join('');
  const gy = 110 - goal / top * 100;
  return `<svg viewBox="0 0 350 140" class="chart" role="img" aria-label="Calories over the last 7 days. Red bars are days with street food. Dashed line is your goal of ${goal} kcal.">
    ${bars}<line x1="0" x2="350" y1="${gy}" y2="${gy}" stroke="currentColor" stroke-dasharray="4 4" opacity=".45"/></svg>`;
}

const dots = streak => `<div class="dots" aria-hidden="true">${[...Array(7)].map((_, i) => `<i class="${i < streak ? 'full' : ''}"></i>`).join('')}</div>`;

function impactHtml() {
  const rows = bodyImpact();
  if (!rows) return '<p class="sub">Log at least 3 meals this week to see how your food is affecting your gut, skin, liver and kidneys.</p>';
  const word = ['On track', 'Watch', 'Concern'], tone = ['var(--leaf)', 'var(--turmeric)', 'var(--chili)'], fill = [28, 64, 100];
  return `<div class="tray impact">${rows.map(r => `<div class="cell ${r.level === null ? 'nodata' : ''}" style="--fill:${r.level === null ? 0 : fill[r.level]}%;--tone:${r.level === null ? '#ccc' : tone[r.level]}">
      <small>${r.organ}</small><b>${r.level === null ? 'No data' : word[r.level]}</b><small>this week</small></div>`).join('')}</div>
    <ul class="reasons">${rows.map(r => `<li><b>${r.organ}.</b> ${esc(r.text)}</li>`).join('')}</ul>
    <p class="sub small">The fill rises with the level of concern. Based only on the meals you logged, so log every meal for a fair picture. This is general guidance, not a medical diagnosis. Talk to a doctor if you have symptoms.</p>`;
}

// ---------- Skin and glow ----------
// Everything in this section is calculated from the meals you logged, not by the AI. It is general nutrition
// guidance, not a diagnosis. Sugar, fibre and salt limits match the dashboard; each skin type weighs them differently.
const skinType = () => (SKIN_TYPES[state.profile.skin] ? state.profile.skin : '');
const mealText = m => `${m.name || ''} ${m.foods || ''}`;
const isOilyMeal = m => !!m.street || (+m.fat || 0) >= 20 || FRIED_WORDS.test(mealText(m));
const isGlowMeal = m => GLOW_WORDS.test(mealText(m));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const SKIN_FACTORS = ['sugar', 'oil', 'fibre', 'salt', 'glow'];
const FACTOR_NAME = { sugar: 'Sugar', oil: 'Fried and oily', fibre: 'Fibre', salt: 'Salt', glow: 'Glow foods' };
const SKIN_WEIGHTS = {
  oily: { sugar: 1.3, oil: 1.5, fibre: 1, salt: 0.7, glow: 1 },
  dry: { sugar: 1, oil: 0.8, fibre: 0.8, salt: 1.5, glow: 1.3 },
  combination: { sugar: 1.2, oil: 1.2, fibre: 1, salt: 1, glow: 1 },
  sensitive: { sugar: 1, oil: 1.1, fibre: 0.8, salt: 1, glow: 1.3 },
  normal: { sugar: 1, oil: 1, fibre: 1, salt: 1, glow: 1 },
};
const LEVEL_SCORE = [100, 60, 25]; // level 0 on track, 1 watch, 2 concern
const NO_DATA = { sugar: 'Not enough sugar data yet.', fibre: 'Not enough fibre data yet.', salt: 'Not enough sodium data yet.', glow: 'Log meals on at least 2 days to check this.' };

// Weighted average of the factor levels, 0 to 100. Factors without data are left out.
function skinScore(levels) {
  const wt = SKIN_WEIGHTS[skinType()] || SKIN_WEIGHTS.normal;
  let top = 0, bottom = 0;
  for (const k of SKIN_FACTORS) {
    const lv = levels[k];
    if (lv === null || lv === undefined) continue;
    top += wt[k] * LEVEL_SCORE[lv]; bottom += wt[k];
  }
  return bottom ? Math.round(top / bottom) : null;
}

const SKIN_OUTLOOK = [
  'Keep this up and skin often looks clearer and brighter within 3 to 4 weeks.',
  'A few small swaps could turn this into a glowing week. Skin usually responds over 3 to 4 weeks.',
  'Your skin may look duller or break out more than it needs to. Fix the first item below and the rest gets easier.',
  'This pattern can leave skin dull, oily or puffy. One change at a time is enough: start with the first tip below.',
];
const skinBand = s => s >= 90 ? { name: 'Glowing week', tone: 'var(--leaf)', css: 'good', outlook: SKIN_OUTLOOK[0] }
  : s >= 75 ? { name: 'Good week', tone: 'var(--leaf)', css: 'good', outlook: SKIN_OUTLOOK[1] }
  : s >= 55 ? { name: 'Mixed week', tone: 'var(--turmeric)', css: '', outlook: SKIN_OUTLOOK[2] }
  : { name: 'Skin-stressing week', tone: 'var(--chili)', css: 'warn', outlook: SKIN_OUTLOOK[3] };

// Plain-language reason for one factor, in the voice of the chosen skin type.
function factorText(key, level, c, type) {
  const t = type || 'normal';
  if (key === 'sugar') {
    const base = `Sugar averages ${Math.round(c.sugar)} g a day.`;
    if (level === 0) return `${base} Steady sugar helps keep skin calm.`;
    return `${base} ${{
      oily: 'Sugar spikes can push oil production and breakouts.',
      dry: 'High sugar over time is linked with duller, less elastic skin.',
      combination: 'Sugar spikes tend to show up in the oily T-zone.',
      sensitive: 'Sugar spikes can feed inflammation, which sensitive skin notices first.',
      normal: 'Sugar spikes are linked with breakouts and dullness.',
    }[t]}`;
  }
  if (key === 'oil') {
    const base = `${plural(c.oily, 'fried, oily or street meal')} this week.`;
    if (level === 0) return `${base} Light on fried food, which is good for your skin.`;
    return `${base} ${{
      oily: 'Heavy, fried meals are usually also high in refined flour and sugar, which are linked with shine and breakouts.',
      dry: 'Fried street food is the wrong kind of fat for dry skin. Choose nuts, seeds and a little ghee instead.',
      combination: 'Heavy, fried meals tend to show up in the oily T-zone.',
      sensitive: 'Heavy, fried food can leave sensitive skin looking flushed or irritated.',
      normal: 'Frequent fried food can dull skin.',
    }[t]}`;
  }
  if (key === 'fibre') {
    const base = `Fibre averages ${Math.round(c.fibre)} g a day (aim for 25 g).`;
    return level === 0 ? `${base} Good fibre keeps blood sugar steady.`
      : `${base} Low fibre means bigger blood sugar swings, and gut health and skin are closely linked.`;
  }
  if (key === 'salt') {
    const base = `Sodium averages ${Math.round(c.sodium)} mg a day (limit about 2000 mg).`;
    if (level === 0) return `${base} Low enough to keep skin hydrated and less puffy.`;
    return t === 'dry' ? `${base} Too much salt pulls water out of skin and makes it look tight and dull.`
      : `${base} Salty food causes puffiness, especially around the eyes, and can dehydrate skin.`;
  }
  const base = `Colourful vegetables and fruit, dal, nuts, seeds or fish showed up on ${c.glowDays} of the ${plural(c.days, 'day')} you logged.`;
  return level === 0 ? `${base} Their vitamins A, C and E, zinc and omega-3 support skin.`
    : `${base} Add one fruit or vegetable and a handful of nuts or seeds every day: the carotenoids in produce give skin a warm, healthy glow.`;
}

function skinAction(key) {
  if (key === 'oil') return skinType() === 'dry'
    ? 'Keep your fats but change the source: nuts, seeds and a little ghee or oil instead of deep-fried snacks.'
    : 'Swap one fried snack a day for a tawa, steamed or roasted option. The swaps in Cook instead are a good start.';
  return {
    sugar: 'Swap one sweet drink or sweet snack a day for fruit, curd or roasted chana.',
    fibre: 'Add dal, sprouts or a salad to two meals a day.',
    salt: 'Skip packaged snacks, pickles and instant noodles for a few days, and drink water through the day.',
    glow: 'Add one fruit or a bowl of vegetables to lunch, and a handful of nuts or seeds as a snack.',
  }[key];
}

// The last 7 calendar days, one skin score each (null when nothing was logged that day).
function skinDays() {
  const [o1, o2] = ['oily', 'combination'].includes(skinType()) ? [1, 2] : [2, 3];
  return [...Array(7)].map((_, i) => {
    const d = Date.now() - (6 - i) * DAY;
    const list = state.meals.filter(m => sameDay(m.at, d));
    const label = new Date(d).toLocaleDateString('en', { weekday: 'short' });
    if (!list.length) return { label, score: null, note: '' };
    const known = key => list.filter(m => has(m[key])).length > 0;
    const sugar = known('sugar') ? sum(list, 'sugar') : null;
    const fibre = list.length >= 2 && known('fibre') ? sum(list, 'fibre') : null;
    const sodium = known('sodium') ? sum(list, 'sodium') : null;
    const oily = list.filter(isOilyMeal).length;
    const levels = {
      sugar: sugar === null ? null : sugar > 50 ? 2 : sugar > 35 ? 1 : 0,
      oil: oily >= o2 ? 2 : oily >= o1 ? 1 : 0,
      fibre: fibre === null ? null : fibre < 15 ? 2 : fibre < 25 ? 1 : 0,
      salt: sodium === null ? null : sodium > 2300 ? 2 : sodium > 1800 ? 1 : 0,
      glow: list.some(isGlowMeal) ? 0 : list.length >= 2 ? 1 : null,
    };
    const parts = [];
    if (sugar !== null) parts.push(`${Math.round(sugar)} g sugar`);
    parts.push(plural(oily, 'oily meal'));
    if (sodium !== null) parts.push(`${Math.round(sodium)} mg sodium`);
    return { label, score: skinScore(levels), note: parts.join(', ') };
  });
}

// The weekly read: five factors from the last 7 days of logged meals, weighted for the chosen skin type.
function skinWeek() {
  const w = weekMeals();
  if (w.length < 3) return null;
  const type = skinType();
  const n = new Set(w.map(m => new Date(m.at).toDateString())).size;
  const avg = key => { const k = w.filter(m => has(m[key])); return k.length >= 3 ? sum(k, key) / n : null; };
  const sugar = avg('sugar'), fibre = avg('fibre'), sodium = avg('sodium');
  const oily = w.filter(isOilyMeal).length;
  const glowDays = new Set(w.filter(isGlowMeal).map(m => new Date(m.at).toDateString())).size;
  const [o1, o2] = ['oily', 'combination'].includes(type) ? [2, 4] : [3, 5];
  const levels = {
    sugar: sugar === null ? null : sugar > 50 ? 2 : sugar > 35 ? 1 : 0,
    oil: oily >= o2 ? 2 : oily >= o1 ? 1 : 0,
    fibre: fibre === null ? null : fibre < 15 ? 2 : fibre < 25 ? 1 : 0,
    salt: sodium === null ? null : sodium > 2300 ? 2 : sodium > 1800 ? 1 : 0,
    glow: n < 2 ? null : glowDays / n >= 0.6 ? 0 : glowDays / n >= 0.3 ? 1 : 2,
  };
  const ctx = { sugar, oily, fibre, sodium, glowDays, days: n };
  const wt = SKIN_WEIGHTS[type] || SKIN_WEIGHTS.normal;
  const rows = SKIN_FACTORS.map(k => ({ key: k, name: FACTOR_NAME[k], level: levels[k], text: levels[k] === null ? NO_DATA[k] : factorText(k, levels[k], ctx, type) }));
  const tips = rows.filter(r => r.level > 0).sort((a, b) => b.level - a.level || wt[b.key] - wt[a.key]).slice(0, 3).map(r => skinAction(r.key));
  const score = skinScore(levels);
  return { score, band: skinBand(score), rows, tips, days: skinDays() };
}

// How kind a recipe is to the chosen skin type: from its name, ingredients and nutrients (null without a skin type).
function skinFit(r) {
  const type = skinType();
  if (!type) return null;
  const text = `${r.meal} ${(r.ingredientsList || r.pantry || []).join(' ')}`;
  const fried = FRIED_WORDS.test(text) || (+r.fat || 0) >= 20;
  const sugary = (+r.sugar || 0) >= 15;
  const salty = (+r.sodium || 0) >= 700;
  if (type === 'dry' ? (salty || fried) : (fried || sugary)) {
    return { tone: 'warn', head: 'Go easy', text: {
      oily: fried ? 'Higher in oil. Go easy if your skin is oily.' : 'Sugary. Keep the portion small, since sugar spikes are linked with breakouts.',
      combination: fried ? 'Higher in oil. It may show in your oily T-zone.' : 'Sugary. Keep the portion small.',
      dry: salty ? 'Salty. Salt can dry skin out, so drink water with it.' : 'Fried. Healthy fat from nuts or seeds suits dry skin better.',
      sensitive: 'Heavy or sugary. This can flare sensitive skin.',
      normal: fried ? 'Fried. Fine now and then.' : 'Sugary. Fine now and then.',
    }[type] };
  }
  // Name the skin-friendly foods that were found, so each card says something different.
  const found = [...new Set([...text.matchAll(new RegExp(GLOW_WORDS.source, 'gi'))].map(m => m[0].toLowerCase()))].slice(0, 2);
  if (found.length) {
    const foods = found.join(' and ');
    return { tone: 'good', head: 'Skin-friendly', text: {
      oily: `Light on oil, with ${foods}. Good for oily skin.`,
      dry: `Not too salty, with ${foods}. Good for dry skin.`,
      combination: `Balanced and light on oil, with ${foods}. Good for combination skin.`,
      sensitive: `Mild and not heavy, with ${foods}. Gentle on sensitive skin.`,
      normal: `Made with ${foods}. Good for your glow.`,
    }[type] };
  }
  return { tone: 'ok', head: 'Fine for skin', text: 'Neutral for your skin. A fruit or some salad on the side would help.' };
}

function skinFitHtml(r) {
  const f = skinFit(r);
  return f ? `<p class="skinfit ${f.tone}"><b>${f.head}.</b> ${esc(f.text)}</p>` : '';
}

// ---- Skin pieces of UI ----
function skinChart(days) {
  const bars = days.map((d, i) => {
    const h = d.score === null ? 4 : Math.max(4, d.score);
    const fill = d.score === null ? 'var(--line)' : d.score >= 75 ? 'var(--leaf)' : d.score >= 55 ? 'var(--turmeric)' : 'var(--chili)';
    return `<rect x="${i * 50 + 8}" y="${110 - h}" width="34" height="${h}" rx="3" fill="${fill}"><title>${esc(d.label)}: ${d.score === null ? 'nothing logged' : 'skin score ' + d.score + '. ' + esc(d.note)}</title></rect>
      <text x="${i * 50 + 25}" y="130" text-anchor="middle" font-size="11" fill="currentColor">${esc(d.label)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 350 140" class="chart skin-days" role="img" aria-label="Daily skin score for the last 7 days. Green bars are 75 or more, amber 55 to 74, red below 55. Grey means nothing was logged.">
    ${bars}<line x1="0" x2="350" y1="35" y2="35" stroke="currentColor" stroke-dasharray="4 4" opacity=".45"/></svg>`;
}

function skinWeekHtml() {
  const r = skinWeek(), type = skinType();
  const pill = type ? ` <span class="tag">${esc(SKIN_TYPES[type].label)} skin</span>` : '';
  const ask = type ? '' : '<p class="sub">Tell us your skin type for advice that fits it. <button class="btn small ghost" data-page="cook">Choose skin type</button></p>';
  if (!r) return `<h3>Your skin and glow this week${pill}</h3><p class="sub">Log at least 3 meals this week to see how your food is affecting your skin and glow.</p>${ask}`;
  const word = ['On track', 'Watch', 'Concern'], tone = ['var(--leaf)', 'var(--turmeric)', 'var(--chili)'], fill = [28, 64, 100];
  const cells = r.rows.map(x => `<div class="cell ${x.level === null ? 'nodata' : ''}" style="--fill:${x.level === null ? 0 : fill[x.level]}%;--tone:${x.level === null ? '#ccc' : tone[x.level]}">
      <small>${esc(x.name)}</small><b>${x.level === null ? 'No data' : word[x.level]}</b><small>this week</small></div>`).join('');
  const tips = r.tips.length ? r.tips : ['Great week for your skin. Keep logging every meal to protect your glow.'];
  return `<h3>Your skin and glow this week${pill}</h3>
    <div class="result-head"><p class="insight ${r.band.css}" style="margin:0"><b>${r.band.name}.</b> ${esc(r.band.outlook)}</p>
      <div class="score" style="--tone:${r.band.tone}"><b>${r.score}</b><span>/100</span><small>skin glow score</small></div></div>
    <h4>Day by day</h4>${skinChart(r.days)}
    <p class="sub small">Daily skin score for the last 7 days. The dashed line marks 75, a good day.</p>
    <h4>What is driving it</h4><div class="tray skin">${cells}</div>
    <ul class="reasons">${r.rows.map(x => `<li><b>${esc(x.name)}.</b> ${esc(x.text)}</li>`).join('')}</ul>
    <h4>What to do next</h4><ul class="reasons">${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    <div class="actions"><button class="btn alt" data-page="cook">Skin-friendly meal ideas</button></div>${ask}
    <p class="sub small">Calculated from the meals you logged, so log every meal for a fair picture. The fill rises with the level of concern. Skin also depends on sleep, water, stress, hormones and sunscreen. This is general guidance, not a medical diagnosis. See a dermatologist for persistent acne or skin problems.</p>`;
}

// The Cook instead page: ask the skin type, then show what to eat and what to go easy on.
function skinBoxHtml() {
  const type = skinType(), g = SKIN_GUIDE[type];
  const chips = Object.entries(SKIN_TYPES).map(([k, v]) => `<button type="button" class="chip btn-chip" data-act="skinPick" data-v="${k}" aria-pressed="${k === type}">${v.label}</button>`).join('')
    + `<button type="button" class="chip btn-chip" data-act="skinPick" data-v="" aria-pressed="${!type}">Not sure</button>`;
  const list = items => items.map(x => `<li>${esc(x)}</li>`).join('');
  const guide = g
    ? `<div class="skin-guide"><h4>Eating for ${esc(SKIN_TYPES[type].label.toLowerCase())} skin</h4>
        <div class="lists"><div><h4>Eat more</h4><ul>${list(g.eat)}</ul></div><div><h4>Go easy on</h4><ul>${list(g.limit)}</ul></div></div>
        <p class="insight good">${esc(g.tip)}</p>
        <p class="sub small">General guidance from nutrition research, not medical advice. See a dermatologist for persistent acne or other skin problems.</p></div>`
    : '<p class="sub small">Pick one and every meal idea below gets a skin note, and the AI suggestions are chosen to suit it.</p>';
  return `<h3>Your skin type</h3>
    <p class="sub">Tell us your skin type so your meal ideas are chosen to suit it.</p>
    <div class="chips" role="group" aria-label="Skin type">${chips}</div>
    <details class="how"><summary>Not sure? Try this quick check</summary>
      <p>Wash your face with a gentle cleanser, pat it dry and leave it bare for 30 minutes. Then look in a mirror:</p>
      <ul>${Object.values(SKIN_TYPES).map(v => `<li><b>${v.label}:</b> ${esc(v.hint)}</li>`).join('')}</ul></details>
    ${guide}`;
}

// ---- Glow forecast for the street-free streak ----
const glowStage = streak => [...GLOW_STAGES].reverse().find(s => streak >= s.day) || null;

function glowLine() {
  const streak = streakDays(), cur = glowStage(streak), next = GLOW_STAGES.find(s => s.day > streak);
  const text = !cur ? 'Skin glow: your forecast starts after your first street-free day.'
    : `Skin glow, day ${streak}: <b>${esc(cur.head)}</b>.` + (next ? ` Next: ${esc(next.head.toLowerCase())} in ${plural(next.day - streak, 'day')}.` : ' You are in the full-glow zone.');
  return `<p class="glowline">✨ ${text}</p>`;
}

function glowForecastHtml() {
  const streak = streakDays(), type = skinType(), cur = glowStage(streak), next = GLOW_STAGES.find(s => s.day > streak);
  const cycle = Math.min(streak, 28);
  const now = cur ? `<p class="insight good"><b>Right now: ${esc(cur.head)}.</b> ${esc(cur.text)}</p>`
    : '<p class="insight">Your forecast starts after your first full street-free day. Keep street food out and log your meals.</p>';
  const items = GLOW_STAGES.map(s => {
    const reached = streak >= s.day, isNext = next === s, by = type && s.by && s.by[type];
    const when = reached ? ' · reached' : isNext ? ` · in ${plural(s.day - streak, 'day')}` : '';
    return `<li class="${reached ? 'reached' : ''}${isNext ? ' next' : ''}"><small class="when">${esc(s.label)}${when}</small><b>${esc(s.head)}</b><span>${esc(s.text)}</span>${by ? `<span class="forskin"><b>For ${esc(SKIN_TYPES[type].label.toLowerCase())} skin:</b> ${esc(by)}</span>` : ''}</li>`;
  }).join('');
  const ask = type ? '' : '<p class="sub small">Want this tuned to your skin? <button class="btn small ghost" data-page="cook">Choose your skin type</button></p>';
  return `<div class="block"><h3>Skin glow forecast</h3>
    <p class="sub">What a street-free streak may do for your skin. ${streak >= 28 ? 'You have gone a full 28-day skin cycle street-free.' : `You are ${plural(streak, 'day')} into a 28-day skin cycle.`}</p>
    <div class="progress" role="progressbar" aria-label="Skin renewal cycle" aria-valuemin="0" aria-valuemax="28" aria-valuenow="${cycle}"><i style="width:${Math.round(cycle / 28 * 100)}%"></i></div>
    ${now}${ask}<ol class="glow">${items}</ol>
    <p class="sub small">These are typical expectations from nutrition research, not promises. Sleep, water, sunscreen, stress, hormones and your skincare routine matter too. See a dermatologist for persistent acne or skin problems.</p></div>`;
}

// ---------- Pages ----------
function dashboard() {
  const today = todayMeals(), tg = targets(), streak = streakDays();
  const name = state.profile.name ? ', ' + esc(state.profile.name) : '';
  const sample = state.sample ? `<div class="banner">These are sample meals so the dashboard is not empty. <button class="btn small" data-act="clearMeals">Clear sample data and start fresh</button></div>` : '';
  return `${sample}<h2>Today${name}</h2><p class="sub">${new Date().toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
  <div class="tray" role="group" aria-label="Today's nutrition against your goals">
    ${cell('Calories', sum(today, 'cal'), tg.cal, ' kcal', 'var(--turmeric)')}
    ${cell('Protein', sum(today, 'protein'), tg.protein, 'g', 'var(--leaf)')}
    ${cell('Carbs', sum(today, 'carbs'), tg.carbs, 'g', '#8fb8d8')}
    ${cell('Fat', sum(today, 'fat'), tg.fat, 'g', 'var(--chili)')}
  </div>
  ${signedIn() ? '<div class="block ai-insight" id="ai-insight"><h3>Today\'s AI insight</h3><p class="sub" role="status">Loading…</p></div>' : ''}
  <div class="block"><h3>Quick checks</h3><p class="sub small">Calculated from your log and goals. The AI insight is above.</p>${insights(today).map(i => `<p class="insight ${i.tone}">${esc(i.text)}</p>`).join('')}
    <div class="actions"><button class="btn alt" data-page="scan">Scan a meal</button></div></div>
  <div class="block split">
    <div><h3>Last 7 days</h3>${weekChart()}<p class="sub">Red bars are days with street food.</p></div>
    <div><h3>Street-free streak</h3><p class="big" style="font-size:2.4rem">${streak} ${streak === 1 ? 'day' : 'days'}</p>
      ${dots(streak)}
      <p class="sub">${claimable() ? 'Your weekly reward is ready to claim.' : streak >= 7 ? 'Weekly reward claimed. Keep going for the next one.' : (7 - streak) + ' more days to your weekly reward.'}</p>
      ${glowLine()}
      <button class="btn" data-page="rewards">See rewards</button></div>
  </div>
  <div class="block"><h3>What this week is doing to your body</h3>${impactHtml()}</div>
  <div class="block" id="skin-week">${skinWeekHtml()}</div>`;
}

function fitLine(f) {
  const tg = targets(), left = Math.round(tg.cal - sum(todayMeals(), 'cal'));
  const pct = Math.round(f.cal / tg.cal * 100);
  if (!f.cal) return '';
  return `${esc(f.name)} is about ${pct}% of your daily goal. ` + (f.cal > left
    ? `That is more than the ${Math.max(0, left)} kcal you have left today.`
    : `That leaves ${left - f.cal} kcal for the rest of the day.`);
}

function healthHtml(f) {
  const h = f.health;
  if (!h) return '';
  const tone = { green: 'var(--leaf)', amber: 'var(--turmeric)', red: 'var(--chili)' }[h.color] || 'var(--leaf)';
  const label = { good: 'Good', moderate: 'Moderate', needs_attention: 'Needs attention' }[h.label] || h.label;
  return `<div class="score" style="--tone:${tone}"><b>${h.score}</b><span>/100</span><small>${esc(label)}</small></div>`;
}

function itemsHtml(f) {
  if (!f.items || !f.items.length) return '';
  const conf = { high: '', medium: ' <small class="conf">medium confidence</small>', low: ' <small class="conf low">low confidence</small>' };
  return `<h4>What is on the plate</h4><ul class="items">${f.items.map(i => `<li><span>${esc(i.name)}${conf[i.confidence] || ''}<br><small>${esc(i.serving || i.grams + ' g')}</small></span><b>${i.cal} kcal</b></li>`).join('')}</ul>`;
}

function resultHtml() {
  const f = scan.result;
  if (f.error) return `<p class="banner warn">${esc(f.error)}</p>`;
  const n = (label, v, unit) => `<div><small>${label}</small><b>${dash(v)}${has(v) ? unit : ''}</b></div>`;
  const risk = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };
  const guess = f.classifier?.predictions?.length
    ? `<p class="sub small">Image model's first guess: ${esc(f.classifier.predictions[0].display_name)} (${Math.round(f.classifier.predictions[0].score * 100)}%). The AI then checked every item on the plate.</p>` : '';
  const lists = f.health
    ? `<div class="lists"><div><h4>Watch out</h4><ul>${f.cons.map(c => `<li>${esc(c)}</li>`).join('') || '<li>Nothing flagged for this meal</li>'}</ul></div>
       <div><h4>Tips</h4><ul>${f.tips.map(t => `<li>${esc(t)}</li>`).join('') || '<li>No tips this time</li>'}</ul></div></div>
       <p class="sub small">${esc(f.health.disclaimer || 'Estimates only — not medical advice.')}</p>`
    : `<div class="lists"><div><h4>Advantages</h4><ul>${f.pros.map(p => `<li>${esc(p)}</li>`).join('') || '<li>None found</li>'}</ul></div>
       <div><h4>Disadvantages</h4><ul>${f.cons.map(c => `<li>${esc(c)}</li>`).join('') || '<li>None found</li>'}</ul></div></div>`;
  return `<div class="block"><div class="result-head"><h3>${esc(f.name)} <span class="tag ${f.street ? 'bad' : ''}">${f.street ? 'Street food' : 'Not street food'}</span></h3>${healthHtml(f)}</div>
    <p class="fit">${fitLine(f)}</p>
    <div class="nutri">${n('Calories', f.cal, ' kcal')}${n('Protein', f.protein, 'g')}${n('Carbs', f.carbs, 'g')}${n('Fat', f.fat, 'g')}${n('Fibre', f.fibre, 'g')}${n('Sodium', f.sodium, 'mg')}${n('Sugar', f.sugar, 'g')}</div>
    ${f.items ? itemsHtml(f) : `<p class="sub" style="margin:10px 0 0">${esc(f.summary)}</p>`}
    ${guess}
    ${f.ingredients.length ? `<div class="chips" aria-label="Ingredients by risk">${f.ingredients.map(i => `<span class="chip ${i.risk}">${esc(i.name)}<small> ${risk[i.risk]}</small></span>`).join('')}</div>` : ''}
    ${lists}
    <label class="check"><input type="checkbox" data-act="toggleStreet" ${f.street ? 'checked' : ''}> This is street food</label>
    <div class="actions"><button class="btn alt" data-act="addMeal" ${scan.added ? 'disabled' : ''}>${scan.added ? 'Added to your log' : 'Add to my log'}</button>
    <button class="btn" data-act="swapFor">Find a home swap</button></div></div>
    <div class="block"><h3>Ask about this food</h3><div class="chat"><div class="msgs" id="msgs" aria-live="polite">${chatHtml()}</div>
    <div class="chips">${['Is it bad for my liver?', 'Is this enough protein for me?', 'What can I eat instead?'].map(q => `<button class="chip btn-chip" data-act="ask" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
    <div class="ask"><input id="q" placeholder="Is it bad for my skin or kidneys?" aria-label="Question about this food"><button class="btn" data-act="send">Ask</button></div></div></div>`;
}

function chatHtml() {
  if (!scan.chat.length) return '<p class="sub">Ask about benefits, risks or healthier options.</p>';
  return scan.chat.map(m => `<div class="msg ${m.me ? 'me' : ''} ${m.markdown ? 'md' : ''} ${m.error ? 'err' : ''}" ${m.error ? 'role="alert"' : ''}>${m.markdown ? md(m.text) : esc(m.text)}${(m.tools || []).map(t => `<small class="tool">✓ ${esc(t.summary)}</small>`).join('')}</div>`).join('');
}

function scanPage() {
  return `<h2>Scan food</h2><p class="sub">Photograph a whole meal or the nutrition label on a packet.</p>
  <fieldset class="mode"><legend class="sr">What are you scanning?</legend>
    <label><input type="radio" name="mode" value="meal" ${scan.mode === 'meal' ? 'checked' : ''}>Whole meal</label>
    <label><input type="radio" name="mode" value="label" ${scan.mode === 'label' ? 'checked' : ''}>Product label</label></fieldset>
  <label class="drop"><input type="file" id="file" class="sr" accept="image/*"><span>Choose a photo, take one, or drop it here</span><small id="fname">${scan.file ? esc(scan.file.name) : 'JPG, PNG or WebP'}</small></label>
  <img id="preview" class="preview" alt="Selected food" ${scan.url ? `src="${scan.url}"` : 'hidden'}>
  <div class="actions"><button class="btn" data-act="analyze" id="analyze">Analyze</button></div>
  <div id="result" aria-live="polite">${scan.result ? resultHtml() : ''}</div>`;
}

function historyPage() {
  const all = [...state.meals].sort((a, b) => b.at - a.at);
  const list = all.filter(m => ui.histFilter === 'all' || (ui.histFilter === 'street' ? m.street : m.home));
  let lastDay = '', body = '';
  list.forEach(m => {
    const day = new Date(m.at).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      body += `<h3 class="day">${dateLabel(m.at)} <small>${Math.round(sum(all.filter(x => sameDay(x.at, m.at)), 'cal'))} kcal</small></h3>`;
    }
    body += `<div class="row"><div><b>${esc(m.name)}</b> ${m.street ? '<span class="tag bad">Street</span>' : ''}${m.home ? '<span class="tag">Home cooked</span>' : ''}
      <small>${new Date(m.at).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })} · ${Math.round(m.cal)} kcal · protein ${m.protein}g · carbs ${m.carbs}g · fat ${m.fat}g</small></div>
      <button class="btn ghost" data-act="remove" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">Remove</button></div>`;
  });
  const f = (key, label) => `<button class="chip btn-chip" data-act="filter" data-v="${key}" aria-pressed="${ui.histFilter === key}">${label}</button>`;
  const week = weekMeals(), street = week.filter(m => m.street).length;
  return `<h2>History</h2><p class="sub">${week.length} meals in the last 7 days, ${street} of them street food.</p>
  <div class="chips">${f('all', 'All')}${f('street', 'Street food')}${f('home', 'Home cooked')}<button class="btn small" data-act="exportCsv">Export CSV</button></div>
  <details class="how add"><summary>Log a meal by hand</summary>
    <div class="form-row"><label>Meal name<input id="m-name" placeholder="Egg roll"></label>
    <label>Calories<input id="m-cal" type="number" min="0" max="3000" placeholder="350"></label></div>
    <label class="check"><input type="checkbox" id="m-street"> Street food</label>
    <button class="btn alt" data-act="addManual">Add meal</button></details>
  ${body || '<p class="empty">No meals here yet. Scan one, or log one by hand.</p>'}`;
}

function gearLabel(r) { return { none: 'No cooking', kettle: 'Kettle only', burner: 'Burner needed' }[r.gear] || ''; }

function recipeCard(r, first) {
  const all = r.ingredientsList || r.pantry || [];
  const ing = all.filter(x => !all.some(y => y !== x && y.includes(x)));
  return `<article class="swap ${first ? 'first' : ''}">
    <div><small>${r.ai ? 'AI suggestion' : r.from ? 'Instead of ' + esc(r.from) : 'Home-cooked idea'}</small><h3>${esc(r.meal)}</h3></div>
    <button class="btn alt" data-act="cooked" data-rid="${esc(r.id)}">I cooked this</button>
    <p>${esc(r.why)}</p>${skinFitHtml(r)}
    <small>${r.time} min · ${r.cal} kcal · protein ${r.protein}g${r.gear ? ' · ' + gearLabel(r) : ''}</small>
    ${(ing.length || (r.steps || []).length) ? `<details class="how"><summary>Ingredients and steps</summary>
      ${ing.length ? `<p><b>Main ingredients:</b> ${ing.map(esc).join(', ')}</p>` : ''}
      ${(r.steps || []).length ? `<ol>${r.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</details>` : ''}
  </article>`;
}

function suggestionsHtml() {
  if (cook.busy) return '<p class="sub" role="status">Finding meals you can make…</p>';
  if (!cook.results) return '';
  const { source, meals, reason } = cook.results;
  if (source === 'error') return `<p class="banner warn" role="alert">Couldn't get meal ideas from the AI. ${esc(reason || '')}</p>`;
  if (!meals.length) return '<p class="empty">The AI found no meal for those ingredients with your kitchen and diet. Add a few more items.</p>';
  const made = cook.results.skin;
  const tuned = made && SKIN_TYPES[made] ? `, tuned for your ${SKIN_TYPES[made].label.toLowerCase()} skin` : '';
  const stale = (made || '') !== skinType() ? '<p class="sub small">Your skin type changed since these ideas were made. Press "Suggest meals" again for ideas tuned to it.</p>' : '';
  return `<p class="sub">Suggested by the AI (Gemini) for what you have, your diet and your kitchen${tuned}.</p>${stale}${meals.map(r => recipeCard(r, false)).join('')}`;
}

function cookPage() {
  const p = state.profile, usable = usableRecipes(p);
  const last = state.meals.filter(m => m.street).sort((a, b) => b.at - a.at)[0];
  const focus = String(cook.focus || (last && last.name) || '').toLowerCase();
  const hit = r => !!focus && r.keys.some(k => focus.includes(k));
  const ordered = [...usable].sort((a, b) => hit(b) - hit(a));
  const rows = ordered.map((r, i) => recipeCard(r, i === 0 && hit(r))).join('');
  const why = cook.focus ? `You asked for a swap for ${esc(cook.focus)}.` : last ? `Your last street meal was ${esc(last.name)}, so matching swaps come first.` : 'Home-cooked swaps for common street food.';
  return `<h2>Cook instead</h2><p class="sub">Showing meals for a ${esc(p.diet)} diet. Kitchen: ${esc((KITCHENS[p.kitchen] || KITCHENS.burner).toLowerCase())}. Change these in Health profile.</p>
  <div class="block skin-block" id="skin-box">${skinBoxHtml()}</div>
  <div class="block"><h3>What is in your room?</h3>
    <label for="pantry">Ingredients you have, separated by commas</label>
    <input id="pantry" value="${esc(cook.pantry)}" placeholder="poha, onion, peanuts" style="max-width:420px;width:100%">
    <div class="chips">${PANTRY_CHIPS.map(c => `<button class="chip btn-chip" data-act="pantryAdd" data-v="${c}">${c}</button>`).join('')}</div>
    <div class="actions"><button class="btn" data-act="suggest" id="suggest">Suggest meals</button></div>
    <div id="suggestions" aria-live="polite">${suggestionsHtml()}</div></div>
  <div class="block"><h3>Swaps for street food</h3><p class="sub">${why}</p>${rows || '<p class="empty">No swaps fit this diet and kitchen. Change them in Health profile.</p>'}</div>`;
}

function rewardsPage() {
  const streak = streakDays(), best = bestStreak(), pts = points(), lv = level(pts), ctx = badgeCtx();
  const next = BADGES.filter(b => b.id[0] === 's').find(b => b.goal > streak);
  const can = claimable();
  const badgeRows = BADGES.map(b => {
    const got = state.badges[b.id];
    return `<div class="badge ${got ? '' : 'locked'}"><span aria-hidden="true">${b.icon}</span>
      <div><b>${b.name}</b><br><small>${got ? 'Unlocked ' + dateLabel(got) : b.desc + ' (' + Math.min(b.of(ctx), b.goal) + ' of ' + b.goal + ')'}</small></div></div>`;
  }).join('');
  return `<h2>Rewards</h2><p class="sub">Go a full week without street food to unlock the weekly reward.</p>
  ${dots(streak)}
  <p class="big" style="font-size:2rem">${streak} day${streak === 1 ? '' : 's'} street-free</p>
  <p class="sub">${next ? (next.goal - streak) + ' more days for "' + next.name + '". ' : 'Every streak badge unlocked. '}Best run so far: ${best} day${best === 1 ? '' : 's'}.</p>
  <div class="block reward ${can ? 'ready' : ''}"><h3>Weekly reward</h3>
    <p>${can ? 'You made it through a full street-free week. Claim 50 bonus points.' : streak >= 7 ? 'Claimed for this week. The next one unlocks after 7 more street-free days.' : 'Unlocks after 7 days in a row without street food.'}</p>
    <button class="btn alt" data-act="claim" ${can ? '' : 'disabled'}>${can ? 'Claim 50 points' : 'Not ready yet'}</button></div>
  ${glowForecastHtml()}
  <div class="block"><h3>Level ${lv.n}: ${lv.name}</h3><div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${lv.into}"><i style="width:${lv.into}%"></i></div>
    <p class="sub">${pts} points. ${100 - lv.into} more for the next level. You earn 10 for every street-free day, 5 for every home-cooked meal and 50 for each weekly reward.</p></div>
  <div class="block"><h3>Badges</h3>${badgeRows}</div>`;
}

function profilePage() {
  const p = state.profile;
  const bmi = p.weight / ((p.height / 100) ** 2);
  const cat = bmi < 18.5 ? 'below the usual range' : bmi < 25 ? 'in the usual range' : bmi < 30 ? 'above the usual range' : 'well above the usual range';
  const field = (id, label, type = 'number', extra = '') => `<label>${label}<input id="p-${id}" type="${type}" value="${esc(p[id])}" ${extra}></label>`;
  const opts = (id, map) => Object.entries(map).map(([v, t]) => `<option value="${v}" ${v === p[id] ? 'selected' : ''}>${t}</option>`).join('');
  const who = isGuestUser()
    ? `<p>You are using a <b>guest session</b>. The AI works the same, but the session ends when you close this tab. Create an account to keep your meals.</p><button class="btn alt" data-act="syncNow">Sync now</button> <button class="btn" data-act="signOut">Sign in or create an account</button>`
    : `<p>Signed in as <b>${esc(authLabel())}</b>. Meals and profile sync to your account.</p><button class="btn alt" data-act="syncNow">Sync now</button> <button class="btn" data-act="signOut">Sign out</button>`;
  return `<h2>Health profile</h2><p class="sub">Your goals shape the dashboard and the advice you get. BMI ${bmi.toFixed(1)} is ${cat}. It is only a rough guide.</p>
  <div class="form-grid">
  ${field('name', 'Name', 'text', 'maxlength="40"')}${field('age', 'Age', 'number', 'min="13" max="100"')}
  <label>Sex<select id="p-sex">${opts('sex', { female: 'Female', male: 'Male', other: 'Prefer not to say' })}</select></label>
  ${field('weight', 'Weight (kg)', 'number', 'min="25" max="250"')}${field('height', 'Height (cm)', 'number', 'min="100" max="230"')}
  <label>Activity<select id="p-activity">${opts('activity', { sitting: 'Mostly sitting', light: 'Light, some walking', active: 'Active, regular exercise' })}</select></label>
  <label>Diet<select id="p-diet">${Object.keys(DIET_RANK).map(d => `<option ${d === p.diet ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
  <label>Weight goal<select id="p-goalDir">${opts('goalDir', { lose: 'Lose weight', maintain: 'Stay the same', gain: 'Gain weight or muscle' })}</select></label>
  <label>Kitchen in your room<select id="p-kitchen">${opts('kitchen', KITCHENS)}</select></label>
  <label>Skin type<select id="p-skin"><option value="">Not set</option>${Object.entries(SKIN_TYPES).map(([v, t]) => `<option value="${v}" ${v === p.skin ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
  <label>Daily calorie goal<input id="p-goal" type="number" min="1200" max="4000" step="50" value="${esc(p.goal)}"></label></div>
  <div class="actions"><button class="btn" data-act="saveProfile">Save profile</button><button class="btn alt" data-act="suggestGoal">Suggest a calorie goal</button></div>
  <div class="block"><h3>Account</h3>${who}</div>
  <div class="block"><h3>Your data</h3><p class="sub">Remove every logged meal and restart your streak. Badges you earned stay.</p><button class="btn ghost" data-act="clearMeals">Clear all logged meals</button></div>`;
}

const pages = { dashboard, scan: scanPage, history: historyPage, cook: cookPage, rewards: rewardsPage, profile: profilePage };

function show(name, opts = {}) {
  if (!pages[name]) name = 'dashboard';
  document.querySelectorAll('#nav button').forEach(b => {
    b.classList.toggle('on', b.dataset.page === name);
    if (b.dataset.page === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  try { $('#main').innerHTML = pages[name](); }
  catch (err) { console.error(err); $('#main').innerHTML = '<h2>Something went wrong</h2><p class="sub">This page could not be shown. Reload it, or open another page from the menu.</p>'; }
  if (location.hash !== '#' + name) {
    try { window.history[opts.push ? 'pushState' : 'replaceState'](null, '', '#' + name); } catch { /* some browsers block this on file:// pages */ }
  }
  window.scrollTo(0, 0);
  if (opts.focus) { const h = $('#main h2'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
  if (name === 'rewards') checkBadges();
  if (name === 'dashboard' && signedIn()) loadInsight();
}
const currentPage = () => location.hash.replace('#', '');

function refreshStatus() {
  const chip = $('#status'), who = $('#who');
  if (who) who.textContent = authLabel();
  if (!chip) return;
  const map = { idle: ['Connecting to the server…', ''], ok: ['Connected to The Nutritionist', 'ok'], ai: ['Connected · AI unavailable: ' + net.detail, 'bad'], offline: ['Server not reachable: is uvicorn running?', 'bad'], http: ['Server error: ' + net.detail, 'bad'] };
  const [text, cls] = map[net.state];
  chip.textContent = text; chip.className = 'status ' + cls;
}

// ---------- Meals: create, log, sync ----------
const newMeal = (f, extra = {}) => ({ id: uid(), at: Date.now(), name: f.name, cal: f.cal, protein: f.protein, carbs: f.carbs, fat: f.fat, fibre: f.fibre ?? null, sodium: f.sodium ?? null, sugar: f.sugar ?? null, satFat: f.satFat ?? null, foods: f.foods ?? (f.items ? f.items.map(i => i.name).join(', ') : ''), street: !!f.street, home: false, synced: false, ...extra });
const canSync = () => !!CFG.endpoints.intake && signedIn();

function logMeal(m) {
  state.meals.push(m);
  save();
  checkBadges();
  if (canSync() && !recentlyOffline()) {
    pushMeal(m).then(id => { m.synced = true; if (id) m.remoteId = String(id); save(); refreshStatus(); }).catch(e => { refreshStatus(); if (!e.offline) toast('Saved on this device. The server said: ' + reasonFor(e)); });
  }
}

// The server is the source of truth for signed-in accounts: unsynced local meals are pushed first, then the
// log is rebuilt from the server's intake entries (last 90 days), keeping local-only flags such as "home cooked".
async function syncNow(manual) {
  if (!canSync()) { if (manual) toast('Sign in to sync your meals'); return; }
  try {
    for (const m of state.meals.filter(x => !x.synced && !x.sample)) { const id = await pushMeal(m); m.synced = true; if (id) m.remoteId = String(id); }
    const remote = await fetchRemoteMeals();
    const local = new Map(state.meals.filter(m => m.synced && !m.sample).map(m => [m.remoteId || m.id, m]));
    const before = state.meals.filter(m => !m.sample).length;
    const fresh = remote.filter(r => !local.has(r.id)).length;
    state.meals = [
      ...remote.map(r => { const l = local.get(r.id); return l ? { ...r, id: l.id, home: l.home, street: l.street || r.street, foods: l.foods || r.foods } : r; }),
      ...state.meals.filter(m => !m.synced && !m.sample),
    ];
    state.sample = false;

    // Bring the saved profile (and the calorie target the server computes) onto this device,
    // but never over changes made here.
    let profileChanged = false;
    if (!state.profileTouched) {
      try {
        const saved = await fetchRemoteProfile();
        if (!state.profile.name && auth.user?.name) saved.name = auth.user.name.slice(0, 40);
        if (saved && Object.keys(saved).some(k => state.profile[k] !== saved[k])) {
          state.profile = { ...state.profile, ...saved };
          profileChanged = true;
        }
      } catch { /* the profile is optional: meals have already synced */ }
    }

    checkBadges(true);
    save(); refreshStatus();
    if (manual) {
      const parts = [];
      if (fresh) parts.push(`${fresh} meal${fresh === 1 ? '' : 's'} came from your account`);
      if (profileChanged) parts.push('your profile was updated from your account');
      toast(parts.length ? `Synced. ${parts.join(' and ')}.` : 'Everything is in sync');
    }
    if ((fresh || profileChanged || before !== state.meals.length) && pages[currentPage()]) show(currentPage());
  } catch (e) {
    refreshStatus();
    if (manual) toast('Sync failed. ' + reasonFor(e));
  }
}

async function loadInsight() {
  const box = $('#ai-insight');
  if (!box) return;
  try {
    const d = await fetchInsight();
    const el = $('#ai-insight');
    if (!el) return;
    const tone = { on_track: 'good', over: 'warn', under: 'info', no_data: 'info' }[d.health_status] || 'info';
    el.innerHTML = `<h3>Today's AI insight</h3><p class="insight ${tone}"><b>${esc(d.headline)}</b> ${esc(d.summary)}</p>
      <ul class="reasons">${d.tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul><p class="sub small">${esc(d.disclaimer)}</p>`;
  } catch (e) {
    const el = $('#ai-insight');
    if (el) el.innerHTML = `<h3>Today's AI insight</h3><p class="sub">Not available right now. ${esc(reasonFor(e))}</p>`;
  }
  refreshStatus();
}

// ---------- Actions ----------
const csvCell = v => { let s = String(v ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function setFile(f) {
  if (!f) return;
  if (!f.type.startsWith('image/')) return toast('Choose an image file (JPG, PNG or WebP)');
  if (f.size > 20 * 1024 * 1024) return toast('That photo is over 20 MB. Choose a smaller one');
  if (scan.url) URL.revokeObjectURL(scan.url);
  scan = { ...scan, file: f, url: URL.createObjectURL(f), result: null, chat: [], added: false };
  const img = $('#preview'); if (img) { img.src = scan.url; img.hidden = false; }
  const n = $('#fname'); if (n) n.textContent = f.name;
  const r = $('#result'); if (r) r.innerHTML = '';
}

async function askAbout(text) {
  const box = $('#q');
  if (!text || !scan.result) return;
  if (box) box.value = '';
  scan.chat.push({ me: true, text });
  scan.chat.push({ text: 'Thinking…', pending: true });
  $('#msgs').innerHTML = chatHtml();
  const a = await askBot(text, scan.result);
  scan.chat = scan.chat.filter(m => !m.pending);
  scan.chat.push({ text: a.text, error: a.error, markdown: a.markdown, tools: a.tools });
  if ((a.tools || []).some(t => t.name === 'log_meal')) { scan.added = true; syncNow(false); toast('Logged to your meals'); }
  refreshStatus();
  const msgs = $('#msgs'); if (msgs) { msgs.innerHTML = chatHtml(); msgs.scrollTop = msgs.scrollHeight; }
}

const actions = {
  async analyze(btn) {
    if (!scan.file) return toast('Choose a photo first');
    if (scan.busy) return;
    scan.busy = true; btn.disabled = true;
    $('#result').innerHTML = `<p class="sub" role="status">Analyzing your food… ${signedIn() ? 'The AI checks every item on the plate; this usually takes 5–30 seconds.' : ''}</p>`;
    const mode = document.querySelector('[name=mode]:checked').value;
    try {
      scan.mode = mode;
      scan.chat = []; scan.added = false;
      try {
        scan.result = await analyzeImage(scan.file, mode);
        state.stats[mode === 'label' ? 'labelScans' : 'mealScans']++;
        save();
      } catch (e) {
        scan.result = { error: e.code === 'NOT_FOOD'
          ? "We couldn't spot any food in that photo. Try a clearer, closer photo of the plate or packet."
          : 'The scan did not finish. ' + reasonFor(e) };
      }
      refreshStatus();
    } finally { scan.busy = false; }
    const box = $('#result'), b = $('#analyze');
    if (b) b.disabled = false;
    if (box) box.innerHTML = resultHtml();
  },
  toggleStreet(box) { scan.result.street = box.checked; const tag = $('#result .tag'); if (tag) { tag.textContent = box.checked ? 'Street food' : 'Not street food'; tag.classList.toggle('bad', box.checked); } },
  addMeal(btn) {
    if (scan.added) return;
    scan.added = true;
    logMeal(newMeal(scan.result, { source: scan.mode, scanId: scan.result.scanId, mealType: scan.result.mealType }));
    btn.disabled = true; btn.textContent = 'Added to your log';
    toast('Added to your log');
  },
  swapFor() { cook.focus = scan.result.name; show('cook', { focus: true, push: true }); },
  ask(btn) { return askAbout(btn.dataset.q); },
  send() { const box = $('#q'); return askAbout(box ? box.value.trim() : ''); },
  cooked(btn) {
    const r = [...RECIPES, ...(cook.results ? cook.results.meals : [])].find(x => x.id === btn.dataset.rid);
    if (!r) return;
    logMeal(newMeal({ name: r.meal, cal: r.cal, protein: r.protein, carbs: r.carbs, fat: r.fat, fibre: r.fibre, sodium: r.sodium, sugar: r.sugar, foods: (r.ingredientsList || r.pantry || []).join(', '), street: false }, { home: true, source: 'swap' }));
    toast('Logged. Nice cooking.');
  },
  pantryAdd(btn) {
    const box = $('#pantry'), items = ingredientTokens(box.value);
    if (!items.includes(stem(btn.dataset.v))) box.value = (box.value.trim().replace(/,$/, '') + ', ' + btn.dataset.v).replace(/^,\s*/, '');
    cook.pantry = box.value;
  },
  // Choosing a skin type is saved on this device and redraws the Cook instead page in place (typed ingredients and scroll position are kept).
  skinPick(btn) {
    const box = $('#pantry'); if (box) cook.pantry = box.value;
    const v = btn.dataset.v;
    state.profile.skin = SKIN_TYPES[v] ? v : '';
    save();
    const y = window.scrollY;
    show('cook');
    window.scrollTo(0, y);
    const again = document.querySelector(`[data-act="skinPick"][data-v="${v}"]`);
    if (again) again.focus({ preventScroll: true });
    toast(SKIN_TYPES[v] ? `Skin type set to ${SKIN_TYPES[v].label.toLowerCase()}` : 'Skin type cleared');
  },
  async suggest(btn) {
    cook.pantry = $('#pantry').value.trim();
    const items = cook.pantry.split(/,|\n|;/).map(s => s.trim()).filter(Boolean);
    if (!items.length) return toast('Add at least one ingredient');
    if (cook.busy) return;
    cook.busy = true; btn.disabled = true; $('#suggestions').innerHTML = suggestionsHtml();
    try {
      cook.results = await suggestMeals(items, state.profile);
      cook.results.skin = skinType(); // the skin type these ideas were made for
    } finally { cook.busy = false; }
    const box = $('#suggestions'), b = $('#suggest');
    if (b) b.disabled = false;
    if (box) box.innerHTML = suggestionsHtml();
    refreshStatus();
  },
  filter(btn) { ui.histFilter = btn.dataset.v; show('history'); },
  addManual() {
    const name = $('#m-name').value.trim(), cal = Math.round(+$('#m-cal').value);
    if (!name) return toast('Enter a meal name');
    if (!(cal >= 0 && cal <= 3000) || $('#m-cal').value === '') return toast('Enter calories between 0 and 3000');
    logMeal(newMeal({ name, cal, protein: 0, carbs: 0, fat: 0, street: $('#m-street').checked || isStreetFood(name) }, { source: 'manual' }));
    toast('Meal added');
    show('history');
  },
  remove(btn) {
    const m = state.meals.find(x => x.id === btn.dataset.id);
    state.meals = state.meals.filter(x => x.id !== btn.dataset.id);
    save();
    if (m && m.synced && !m.sample && canSync()) deleteMeal(m.remoteId || m.id).catch(() => {});
    show('history');
  },
  exportCsv() {
    const head = ['date', 'time', 'meal', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fibre_g', 'sodium_mg', 'sugar_g', 'street_food', 'home_cooked'];
    const rows = [...state.meals].sort((a, b) => a.at - b.at).map(m => {
      const d = new Date(m.at);
      return [d.toLocaleDateString('en-CA'), d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), m.name, m.cal, m.protein, m.carbs, m.fat, m.fibre ?? '', m.sodium ?? '', m.sugar ?? '', m.street ? 'yes' : 'no', m.home ? 'yes' : 'no'].map(csvCell).join(',');
    });
    const url = URL.createObjectURL(new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'the-nutritionist-history.csv' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  claim() {
    if (!claimable()) return;
    state.claims.push(Date.now());
    save(); toast('Weekly reward claimed: +50 points');
    show('rewards');
  },
  async suggestGoal() {
    if (signedIn()) {
      const f = k => $('#p-' + k).value;
      try {
        await pushProfile({ age: f('age'), sex: f('sex'), height: f('height'), weight: f('weight'), activity: f('activity'), goalDir: f('goalDir'), diet: f('diet') });
        const t = await fetchTargets();
        $('#p-goal').value = Math.min(4000, Math.max(1200, Math.round(t.calories)));
        toast(`Suggested ${Math.round(t.calories)} kcal a day for your goal. Save to keep it.`);
        return;
      } catch (e) { toast('Could not ask the server: ' + reasonFor(e)); }
    }
    const v = k => +$('#p-' + k).value, sex = $('#p-sex').value, act = { sitting: 1.3, light: 1.5, active: 1.7 }[$('#p-activity').value];
    const bmr = 10 * v('weight') + 6.25 * v('height') - 5 * v('age') + { male: 5, female: -161, other: -78 }[sex];
    const goal = Math.round(bmr * act / 50) * 50;
    if (!Number.isFinite(goal) || goal < 1000) return toast('Fill in age, weight and height first');
    $('#p-goal').value = Math.min(4000, Math.max(1200, goal));
    toast(`Estimated daily need: about ${goal} kcal. Adjust it if you like, then save.`);
  },
  async saveProfile() {
    const val = k => $('#p-' + k).value, p = {};
    const ranges = { age: [13, 100, 'Age'], weight: [25, 250, 'Weight'], height: [100, 230, 'Height'], goal: [1200, 4000, 'Calorie goal'] };
    for (const [k, [lo, hi, label]] of Object.entries(ranges)) {
      const n = +val(k);
      if (!(n >= lo && n <= hi)) return toast(`${label} should be between ${lo} and ${hi}`);
      p[k] = n;
    }
    ['name', 'sex', 'activity', 'goalDir', 'diet', 'kitchen', 'skin'].forEach(k => { p[k] = val(k).trim(); });
    state.profile = { ...state.profile, ...p };
    state.profileTouched = true;
    save();
    if (canSync() && CFG.endpoints.profile) {
      try { await pushProfile(state.profile); toast('Profile saved and synced'); refreshStatus(); }
      catch (e) { toast('Profile saved on this device. ' + reasonFor(e)); refreshStatus(); }
    } else toast('Profile saved on this device');
    show('profile');
  },
  syncNow() { return syncNow(true); },
  signOut() { return signOut(); },
  clearMeals() {
    if (!confirm('Remove all logged meals and restart your streak?')) return;
    if (state.sample) dropSample(Date.now());
    state.meals = []; state.startedOn = Date.now();
    save(); toast('Cleared. Your log is empty.');
    show(currentPage() || 'dashboard');
  },
};

// ---------- Events ----------
document.addEventListener('click', e => {
  const t = e.target.closest('[data-page],[data-act]');
  if (!t || t.disabled) return;
  if (t.dataset.page) return show(t.dataset.page, { focus: true, push: true });
  if (t.tagName === 'INPUT') return;
  run(t.dataset.act, t);
});

document.addEventListener('change', e => {
  if (e.target.id === 'file') return setFile(e.target.files[0]);
  if (e.target.dataset.act === 'toggleStreet') run('toggleStreet', e.target);
  if (e.target.name === 'mode') scan.mode = e.target.value;
});

document.addEventListener('dragover', e => { if (e.target.closest('.drop')) { e.preventDefault(); e.target.closest('.drop').classList.add('over'); } });
document.addEventListener('dragleave', e => { const z = e.target.closest && e.target.closest('.drop'); if (z) z.classList.remove('over'); });
document.addEventListener('drop', e => {
  const z = e.target.closest('.drop');
  if (!z) return;
  e.preventDefault(); z.classList.remove('over');
  setFile(e.dataTransfer.files[0]);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'q') run('send', e.target);
  if (e.target.id === 'pantry') run('suggest', $('#suggest'));
});

function run(name, el) {
  if (!actions[name]) return;
  Promise.resolve(actions[name](el)).catch(err => { console.error(err); toast('Something went wrong. Please try again.'); });
}

window.addEventListener('hashchange', () => { const p = currentPage(); if (pages[p] && $('#main')) show(p); });

// ---------- Start ----------
// While the server is unreachable, check every 10 s and update the sidebar as soon as it is back.
function watchServer() {
  setInterval(async () => {
    if (net.state !== 'offline') return;
    if (await pingServer()) { refreshStatus(); toast('Connected to the server again'); }
  }, 10000);
}

(async function boot() {
  refreshStatus(); // "Connecting to the server…"
  await pingServer();
  refreshStatus();
  watchServer();
  await startAuth();
  loadState();
  checkBadges(true);
  refreshStatus();
  show(pages[currentPage()] ? currentPage() : 'dashboard');
  syncNow(false);
})();
