// ScanMyFood web: everything that talks to the Spring Boot backend.
// Every call has a local fallback, so the demo keeps working without a server.
const CFG = window.SMF_CONFIG;

// SECURITY: this older prototype called Gemini straight from the browser with an API key pasted on this line,
// which shows the key to anyone who opens the page. It also used gemini-2.0-flash, which Google has shut down.
// The key has been removed. Use the current web app instead: start the backend and open http://localhost:8000/app/
// (the `frontend/` folder). It keeps the key on the server, in `.env`.
const GEMINI_API_KEY = '';

async function callGemini(prompt, base64Image = null, mimeType = null) {
  if (!GEMINI_API_KEY) throw new Error('direct browser calls are disabled for security; open http://localhost:8000/app/ instead');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const parts = [{ text: prompt }];
  if (base64Image) {
    parts.push({ inlineData: { mimeType, data: base64Image } });
  }
  const body = { contents: [{ parts }] };
  
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Gemini API Error: ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.match(/```(?:json)?\n?([\s\S]*?)```/);
  try {
    return JSON.parse(match ? match[1] : text);
  } catch {
    return text;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- Connection status (shown in the sidebar) ----------
// state: 'idle' (no call yet) | 'ok' | 'http' (server answered with an error) | 'offline'
const net = { state: 'idle', detail: '', lastFail: 0 };

async function getToken() {
  try { return window.getAuthToken ? await window.getAuthToken() : null; } catch { return null; }
}

function endpoint(name) {
  const path = CFG.endpoints[name];
  if (!path) { const e = new Error('disabled'); e.disabled = true; throw e; }
  return path;
}

async function callApi(path, options = {}) {
  const token = await getToken();
  const headers = { ...(token && { Authorization: 'Bearer ' + token }), ...(options.headers || {}) };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CFG.requestTimeoutMs);
  try {
    const res = await fetch(CFG.apiBase + path, { ...options, headers, signal: ctl.signal });
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status);
      e.status = res.status; e.path = path;
      net.state = 'http'; net.detail = `HTTP ${res.status} on ${path}`;
      throw e;
    }
    net.state = 'ok'; net.detail = '';
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (e) {
    if (!e.status && !(e instanceof SyntaxError)) {
      net.state = 'offline'; net.detail = e.name === 'AbortError' ? 'Request timed out' : 'Server not reachable';
      net.lastFail = Date.now();
      e.offline = true;
    }
    e.path = e.path || path;
    throw e;
  } finally { clearTimeout(timer); }
}

// Plain-language reason a call fell back to local data (shown to the team while integrating).
function reasonFor(e) {
  if (e.disabled) return 'This feature is switched off in config.js.';
  if (e.offline) return `The server at ${CFG.apiBase} did not respond (${net.detail.toLowerCase()}). Is it running, and does it allow CORS from this page?`;
  if (e.status === 401 || e.status === 403) return `The server rejected the request (${e.status}). It probably needs a Firebase sign-in token: sign in first.`;
  if (e.status) return `The server answered ${e.status} for ${e.path}. Check the path and field names in config.js.`;
  return 'The reply was not in a shape the app understands. Check normalize() in api.js.';
}

// True when a background sync should not bother the server (it just failed).
const recentlyOffline = () => net.state === 'offline' && Date.now() - net.lastFail < 30000;

// ---------- Mapping backend JSON to the shape the UI uses ----------
// Edit the candidate key lists here if your backend uses different names. First match wins.
const pick = (o, keys, d) => { for (const k of keys) { const v = o?.[k]; if (v !== undefined && v !== null && v !== '') return v; } return d; };
const num = v => { if (v === undefined || v === null || v === '') return null; const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null; };
const textList = v => Array.isArray(v)
  ? v.map(x => typeof x === 'string' ? x : pick(x, ['text', 'name', 'description', 'title'], '')).map(String).filter(Boolean)
  : (typeof v === 'string' && v ? v.split(/\n|;|•/).map(s => s.trim()).filter(Boolean) : []);
const riskOf = v => /high|harm|danger|avoid/i.test(String(v)) ? 'high' : /med|caution|moderate/i.test(String(v)) ? 'medium' : 'low';

function normalize(raw) {
  const r = raw?.data ?? raw?.result ?? raw?.food ?? raw ?? {};
  const n = r.nutrition ?? r.nutrients ?? r.macros ?? r.nutritionalInfo ?? {};
  const get = keys => num(pick(r, keys, pick(n, keys, null)));
  const name = String(pick(r, ['name', 'foodName', 'food_name', 'dishName', 'productName', 'title'], 'Unknown food'));
  const flag = pick(r, ['street', 'isStreetFood', 'streetFood'], null);
  const ing = pick(r, ['ingredients', 'ingredientAnalysis'], []);
  return {
    name,
    cal: Math.round(get(['calories', 'cal', 'kcal', 'energy', 'energyKcal']) ?? 0),
    protein: get(['protein', 'proteins']) ?? 0,
    carbs: get(['carbs', 'carbohydrates', 'carbohydrate']) ?? 0,
    fat: get(['fat', 'fats', 'totalFat']) ?? 0,
    fibre: get(['fibre', 'fiber', 'dietaryFiber']),
    sodium: get(['sodium', 'sodiumMg']),
    sugar: get(['sugar', 'sugars', 'totalSugar']),
    street: flag === null ? isStreetFood(name) : !!flag,
    summary: String(pick(r, ['summary', 'description', 'overview'], '')),
    pros: textList(pick(r, ['pros', 'advantages', 'benefits', 'positives'], [])),
    cons: textList(pick(r, ['cons', 'disadvantages', 'risks', 'concerns', 'negatives'], [])),
    ingredients: Array.isArray(ing)
      ? ing.map(i => typeof i === 'string' ? { name: i, risk: 'low' } : { name: String(pick(i, ['name', 'ingredient'], '')), risk: riskOf(pick(i, ['risk', 'riskLevel', 'safety', 'level'], 'low')) }).filter(i => i.name)
      : [],
  };
}

function normalizeMeal(r) {
  const at = Date.parse(pick(r, ['at', 'loggedAt', 'createdAt', 'timestamp', 'date'], '')) || num(pick(r, ['at', 'timestamp'], null)) || Date.now();
  return { ...normalize(r), id: String(pick(r, ['id', 'mealId', 'scanId'], Math.random().toString(36).slice(2))), at, home: !!r.home, synced: true };
}

function normalizeRecipe(r, i) {
  const get = keys => num(pick(r, keys, null));
  return {
    id: 'ai-' + i,
    meal: String(pick(r, ['name', 'meal', 'title', 'dish'], 'Meal idea')),
    from: '', keys: [], ai: true,
    time: get(['time', 'minutes', 'cookingTime', 'prepTime']) ?? 20,
    cal: Math.round(get(['calories', 'cal', 'kcal']) ?? 0), protein: get(['protein']) ?? 0, carbs: get(['carbs', 'carbohydrates']) ?? 0,
    fat: get(['fat']) ?? 0, fibre: get(['fibre', 'fiber']), sodium: get(['sodium']), sugar: get(['sugar']),
    why: String(pick(r, ['why', 'reason', 'description', 'summary', 'benefit'], '')),
    steps: textList(pick(r, ['steps', 'instructions', 'method', 'directions'], [])),
    ingredientsList: textList(pick(r, ['ingredients', 'items'], [])),
  };
}

// Turns a saved profile from the server into the fields the profile page uses.
// Only values that are present and inside the allowed ranges are returned, so a partial or odd reply cannot break the page.
function normalizeProfile(raw) {
  const r = raw?.data ?? raw?.profile ?? raw;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  const inRange = (keys, lo, hi) => { const v = num(pick(r, keys, null)); return v !== null && v >= lo && v <= hi ? v : undefined; };
  const word = keys => String(pick(r, keys, '')).trim().toLowerCase();
  const name = String(pick(r, ['name', 'displayName', 'fullName'], '')).trim().slice(0, 40);
  if (name) out.name = name;
  const set = (key, v) => { if (v !== undefined) out[key] = v; };
  set('age', inRange(['age'], 12, 100));
  set('weight', inRange(['weight', 'weightKg'], 25, 250));
  set('height', inRange(['height', 'heightCm'], 100, 230));
  set('goal', inRange(['calorieGoal', 'goal', 'dailyCalories', 'dailyCalorieGoal'], 1200, 4000));
  const sex = word(['sex', 'gender']); if (['female', 'male', 'other'].includes(sex)) out.sex = sex;
  const act = word(['activity', 'activityLevel']); if (['sitting', 'light', 'active'].includes(act)) out.activity = act;
  const diet = Object.keys(DIET_RANK).find(d => d.toLowerCase() === word(['diet', 'dietType'])); if (diet) out.diet = diet;
  const kit = word(['kitchen', 'kitchenType']); if (KITCHENS[kit]) out.kitchen = kit;
  return Object.keys(out).length ? out : null;
}

// ---------- Photo prep ----------
// Phone photos are often 4-8 MB. Shrinking them keeps the upload fast and the AI request small.
async function prepareImage(file, maxDim = 1280) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 600000) { bmp.close?.(); return file; }
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

// ---------- Scan ----------
async function analyzeImage(file, mode) {
  try {
    const img = await prepareImage(file);
    const base64 = await fileToBase64(img);
    const prompt = `Analyze this food image. Return a JSON object with the following fields: 
    - name: string (food name)
    - calories: number
    - protein: number
    - carbs: number
    - fat: number
    - fibre: number
    - sodium: number
    - sugar: number
    - street: boolean (is it street food?)
    - summary: string (short description)
    - pros: array of strings (health benefits)
    - cons: array of strings (health risks)
    - ingredients: array of objects { name: string, risk: "low" | "medium" | "high" }
    Make sure to return only the JSON.`;
    const food = normalize(await callGemini(prompt, base64, img.type));
    if (food.name === 'Unknown food' && !food.cal) throw new Error('empty reply');
    return { ...food, demo: false };
  } catch (e) {
    console.error(e);
    const sample = mode === 'label' ? foods[2] : foods[(file.size + file.name.length) % foods.length];
    return { ...sample, demo: true, demoReason: 'Gemini API failed: ' + e.message };
  }
}

// ---------- Chat about a scanned food ----------
function localAnswer(question, f) {
  const q = question.toLowerCase();
  const say = (label, ok, warn) => `${label} ${warn ? 'Watch out: ' + warn : ok}`;
  if (/liver|oil|fry|fried/.test(q)) return say('Liver:', `${f.name} is not high in fat (${f.fat} g).`, f.fat >= 20 ? `${f.fat} g of fat${f.street ? ', and street stalls often reuse frying oil' : ''}. Eating this often makes your liver work harder.` : '');
  if (/kidney|salt|sodium/.test(q)) return say('Kidneys:', f.sodium === null ? 'No sodium value was found for this food.' : `Sodium is ${f.sodium} mg, which is fine.`, f.sodium !== null && f.sodium > 700 ? `${f.sodium} mg of sodium in one serving (the daily limit is about 2000 mg). Drink water and keep the rest of the day low in salt.` : '');
  if (/skin|acne|pimple|sugar/.test(q)) return say('Skin:', f.sugar === null ? 'No sugar value was found for this food.' : `Sugar is ${f.sugar} g, which is low.`, f.sugar !== null && f.sugar > 15 ? `${f.sugar} g of sugar. High sugar and very oily food are linked with more breakouts.` : (f.fat >= 20 ? 'Very oily food is linked with more breakouts when eaten often.' : ''));
  if (/gut|digest|stomach|fibre|fiber|bloat/.test(q)) return say('Gut:', f.fibre === null ? 'No fibre value was found for this food.' : `Fibre is ${f.fibre} g, which is decent.`, f.fibre !== null && f.fibre < 4 ? `only ${f.fibre} g of fibre. Pair it with vegetables, fruit or dal to keep digestion regular.` : '');
  if (/good|benefit|advantage|pro\b|positive/.test(q)) return `What ${f.name} does well: ${f.pros.join(', ') || 'not much'}.`;
  if (/bad|risk|harm|disadvantage|con\b/.test(q)) return `Watch out for: ${f.cons.join(', ') || 'nothing major'}.`;
  if (/instead|alternative|swap|healthier|replace/.test(q)) return 'Open "Cook instead" for a home-cooked swap you can make in under 30 minutes.';
  return `${f.summary} Roughly ${f.cal} kcal per serving.`;
}

async function askBot(question, food, profile) {
  try {
    const prompt = `Context about the food: ${JSON.stringify(food)}. 
    User's Diet: ${profile?.diet || 'None'}. Calorie Goal: ${profile?.goal || 'None'}.
    Question: ${question}
    Answer the question as a helpful nutritionist chatbot. Keep it short.`;
    const result = await callGemini(prompt);
    const answer = typeof result === 'string' ? result : (result.answer || result.reply || result.text || '');
    if (!answer) throw new Error('empty response');
    return { text: String(answer), demo: false };
  } catch (e) {
    console.error(e);
    return { text: localAnswer(question, food), demo: true, reason: 'Gemini API failed: ' + e.message };
  }
}

// ---------- Meal ideas from the ingredients in the room ----------
async function suggestMeals(items, profile) {
  try {
    const prompt = `Suggest meal ideas based on these ingredients: ${items.join(', ')}.
    Diet: ${profile?.diet || 'None'}, Kitchen: ${profile?.kitchen || 'None'}, Calorie Goal: ${profile?.goal || 'None'}.
    Return a JSON array of objects, where each object has:
    - name: string (dish name)
    - time: number (minutes)
    - calories: number
    - protein: number
    - carbs: number
    - fat: number
    - fibre: number
    - sodium: number
    - sugar: number
    - why: string (reason for suggestion)
    - steps: array of strings (instructions)
    - ingredients: array of strings
    Return only the JSON array.`;
    let r = await callGemini(prompt);
    let arr = Array.isArray(r) ? r : (r.meals || r.suggestions || r.recipes || r.items || []);
    if (!Array.isArray(arr) || !arr.length) throw new Error('Not an array');
    return { source: 'ai', meals: arr.map(normalizeRecipe) };
  } catch (e) {
    console.error(e);
    return { source: 'list', meals: localSuggest(items, profile), reason: 'Gemini API failed: ' + e.message };
  }
}

// ---------- Sync (all optional; failures never block the UI) ----------
const jsonHeaders = { 'Content-Type': 'application/json' };

async function fetchRemoteMeals() {
  const r = await callApi(endpoint('meals'));
  const arr = Array.isArray(r) ? r : pick(r, ['meals', 'items', 'content', 'data'], []);
  if (!Array.isArray(arr)) throw new Error('shape');
  return arr.map(normalizeMeal);
}
async function pushMeal(m) {
  const r = await callApi(endpoint('meals'), { method: 'POST', body: JSON.stringify(m), headers: jsonHeaders });
  return r && pick(r, ['id', 'mealId', 'scanId'], null);
}
const deleteMeal = id => callApi(endpoint('meals') + '/' + encodeURIComponent(id), { method: 'DELETE' });
const fetchRemoteProfile = async () => normalizeProfile(await callApi(endpoint('profile')));
const pushProfile = p => callApi(endpoint('profile'), { method: 'PUT', body: JSON.stringify(p), headers: jsonHeaders });
