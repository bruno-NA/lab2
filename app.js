/* BlockFit – weather-based outfit planner.
   Pure client-side (no build step, no backend) so it runs on GitHub Pages.
   - Weather: Open-Meteo (free, no API key)
   - Closet photos: IndexedDB (stays in this browser)
   - Settings/avatar: localStorage                                           */
'use strict';

/* =====================================================================
   Config
   ===================================================================== */
const CATEGORIES = {
  top:        { label: 'Top',            icon: '👕' },
  outerwear:  { label: 'Jacket / Coat',  icon: '🧥' },
  bottom:     { label: 'Bottom',         icon: '👖' },
  shoes:      { label: 'Shoes',          icon: '👟' },
  hat:        { label: 'Hat',            icon: '🧢' },
  scarf:      { label: 'Scarf',          icon: '🧣' },
  sunglasses: { label: 'Sunglasses',     icon: '🕶️' },
  umbrella:   { label: 'Umbrella',       icon: '☂️' }
};
const SLOT_ORDER = ['hat', 'sunglasses', 'scarf', 'outerwear', 'top', 'bottom', 'shoes', 'umbrella'];
const REQUIRED_SLOTS = ['top', 'bottom', 'shoes'];
const NO_WARMTH = ['sunglasses', 'umbrella'];
const NO_WATERPROOF = ['sunglasses', 'umbrella'];
const WARMTH_LABELS = ['', 'Very light', 'Light', 'Medium', 'Warm', 'Very warm'];

const SKIN_TONES = ['#f5d5b8', '#e8b98f', '#c68c5d', '#8d5a3b', '#5a3825'];
const HAIR_COLORS = ['#1a1209', '#4a2f1b', '#8b5a2b', '#d9a441', '#c0392b', '#9aa0a6', '#6c5ce7', '#2ecc71'];
const EYE_COLORS = ['#4b3621', '#2e86de', '#27ae60', '#7f8c8d'];
const HAIR_STYLES = ['short', 'long', 'spiky', 'ponytail', 'bald'];

const SETTINGS_KEY = 'blockfit.settings.v1';

/* =====================================================================
   Tiny helpers
   ===================================================================== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* Colors */
const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbStr = a => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
const shade = (a, f) => a.map(v => Math.max(0, Math.min(255, v * f)));
const shadeHex = (hex, f) => rgbStr(shade(hexToRgb(hex), f));

/* =====================================================================
   Settings (localStorage)
   ===================================================================== */
function defaultSettings() {
  return {
    location: null,
    units: 'imperial',
    avatarEdited: false,
    avatar: { name: '', skin: SKIN_TONES[1], hair: HAIR_COLORS[1], hairStyle: 'short', eyes: EYE_COLORS[1] }
  };
}

function sanitizeSettings(s) {
  const d = defaultSettings();
  s = s && typeof s === 'object' ? s : {};
  const a = s.avatar && typeof s.avatar === 'object' ? s.avatar : {};
  const hex = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
  const loc = s.location;
  return {
    location: loc && Number.isFinite(+loc.lat) && Number.isFinite(+loc.lon)
      ? { name: String(loc.name || 'Saved place').slice(0, 80), lat: +loc.lat, lon: +loc.lon }
      : null,
    units: s.units === 'metric' ? 'metric' : 'imperial',
    avatarEdited: !!s.avatarEdited,
    avatar: {
      name: String(a.name || '').slice(0, 16),
      skin: hex(a.skin, d.avatar.skin),
      hair: hex(a.hair, d.avatar.hair),
      eyes: hex(a.eyes, d.avatar.eyes),
      hairStyle: HAIR_STYLES.includes(a.hairStyle) ? a.hairStyle : d.avatar.hairStyle
    }
  };
}

function loadSettings() {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY))); }
  catch { return defaultSettings(); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
}

/* =====================================================================
   Closet storage (IndexedDB)
   ===================================================================== */
const DB_NAME = 'blockfit';
const STORE = 'closet';
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function dbTx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const dbAll = () => dbTx('readonly', s => s.getAll());
const dbPut = item => dbTx('readwrite', s => s.put(item));
const dbDelete = id => dbTx('readwrite', s => s.delete(id));
const dbClear = () => dbTx('readwrite', s => s.clear());

/* =====================================================================
   State
   ===================================================================== */
let settings = loadSettings();
let closet = [];          // [{id,name,category,warmth,waterproof,image,added}]
let weather = null;       // normalized weather for today
let outfit = {};          // slot -> item id
let outfitNotes = [];
let editingId = null;
let pendingImage = null;
const imgCache = new Map();

const byCat = c => closet.filter(i => i.category === c);

/* =====================================================================
   Images
   ===================================================================== */
function fileToResizedDataURL(file, maxW = 500) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
}
function getImage(item) {
  if (!imgCache.has(item.id)) imgCache.set(item.id, loadImage(item.image));
  return imgCache.get(item.id);
}

/* Center-crop the photo (to skip plain backgrounds) and shrink it to w×h blocks */
function sampleCanvas(img, w, h) {
  const crop = 0.72, ratio = w / h;
  let sw = img.width * crop, sh = sw / ratio;
  if (sh > img.height * crop) { sh = img.height * crop; sw = sh * ratio; }
  const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
  const big = document.createElement('canvas');
  big.width = w * 4; big.height = h * 4;
  const bctx = big.getContext('2d');
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(img, sx, sy, sw, sh, 0, 0, big.width, big.height);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, w, h);
  return c;
}
function solidCanvas(w, h, rgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = rgbStr(rgb);
  ctx.fillRect(0, 0, w, h);
  return c;
}
function avgColor(img) {
  const d = sampleCanvas(img, 8, 8).getContext('2d').getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return [r / n, g / n, b / n];
}

async function buildLayers(slots) {
  const layers = {};
  await Promise.all(Object.entries(slots).map(async ([slot, item]) => {
    if (!item) return;
    try {
      const img = await getImage(item);
      const cache = {};
      layers[slot] = {
        item,
        color: avgColor(img),
        sample: (w, h) => cache[w + 'x' + h] || (cache[w + 'x' + h] = sampleCanvas(img, w, h))
      };
    } catch {
      layers[slot] = { item, color: [128, 128, 128], sample: (w, h) => solidCanvas(w, h, [128, 128, 128]) };
    }
  }));
  return layers;
}

/* =====================================================================
   Avatar renderer (pixel grid, Minecraft-style proportions)
   Grid: head 8×8, body 8×12, arms 4×12, legs 4×12. 1 block = U pixels.
   Clothing photos are shrunk into blocks and painted on the body.
   ===================================================================== */
const U = 10, CW = 26, CH = 40, OX = 3, OY = 6;

async function renderAvatar(canvas, avatar, slots, sky) {
  const token = (canvas._t = (canvas._t || 0) + 1);
  const layers = await buildLayers(slots || {});
  if (token !== canvas._t) return;   // a newer render started

  canvas.width = CW * U;
  canvas.height = CH * U;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const px = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect((OX + x) * U, (OY + y) * U, w * U, h * U); };
  const tile = (src, sx, sy, sw, sh, x, y, w, h) => ctx.drawImage(src, sx, sy, sw, sh, (OX + x) * U, (OY + y) * U, w * U, h * U);
  const whole = (src, x, y, w, h) => tile(src, 0, 0, src.width, src.height, x, y, w, h);

  // sky + ground
  ctx.fillStyle = sky || '#8ecbf0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const gy = (OY + 32) * U;
  for (let x = 0; x < CW; x++) {
    ctx.fillStyle = x % 3 === 0 ? '#68b23c' : '#5aa032';
    ctx.fillRect(x * U, gy, U, U);
    ctx.fillStyle = (x * 7) % 5 === 0 ? '#694a32' : (x * 3) % 4 === 0 ? '#8a6240' : '#79553a';
    ctx.fillRect(x * U, gy + U, U, U);
  }

  const skin = avatar.skin;
  const skinD = shadeHex(skin, 0.88);

  /* ----- legs ----- */
  px(4, 20, 4, 12, skin);
  px(8, 20, 4, 12, skinD);
  const botL = layers.bottom;
  const legLen = botL && botL.item.warmth <= 1 ? 5 : 12;   // warmth 1 = shorts
  if (botL) {
    whole(botL.sample(4, legLen), 4, 20, 4, legLen);
    whole(botL.sample(4, legLen), 8, 20, 4, legLen);
  } else {
    px(4, 20, 4, 12, '#3d4fa3');
    px(8, 20, 4, 12, '#35459a');
  }
  px(8, 20, 4, legLen, 'rgba(0,0,0,.10)');

  /* ----- shoes ----- */
  const shL = layers.shoes;
  for (const x of [4, 8]) {
    if (shL) whole(shL.sample(4, 3), x, 29, 4, 3); else px(x, 29, 4, 3, '#5b5b5b');
    px(x, 31, 4, 1, 'rgba(0,0,0,.4)');
  }

  /* ----- torso + arms ----- */
  const topL = layers.top, outL = layers.outerwear;
  const topWarm = topL ? topL.item.warmth : 2;
  const sleeve = topWarm >= 3 ? 10 : 4;                   // warmth 1-2 = short sleeves
  px(0, 8, 4, 12, skin);
  px(12, 8, 4, 12, skinD);
  if (topL) whole(topL.sample(8, 12), 4, 8, 8, 12); else px(4, 8, 8, 12, '#3ba7a0');

  if (outL) {
    // open jacket: two panels with the top showing in the middle
    const o = outL.sample(8, 12);
    tile(o, 0, 0, 3, 12, 4, 8, 3, 12);
    tile(o, 5, 0, 3, 12, 9, 8, 3, 12);
    px(6, 8, 1, 12, 'rgba(0,0,0,.22)');
    px(9, 8, 1, 12, 'rgba(0,0,0,.22)');
    px(4, 8, 8, 1, 'rgba(0,0,0,.18)');
    whole(outL.sample(4, 10), 0, 8, 4, 10);
    whole(outL.sample(4, 10), 12, 8, 4, 10);
    px(0, 17, 4, 1, 'rgba(0,0,0,.18)');
    px(12, 17, 4, 1, 'rgba(0,0,0,.18)');
  } else if (topL) {
    whole(topL.sample(4, sleeve), 0, 8, 4, sleeve);
    whole(topL.sample(4, sleeve), 12, 8, 4, sleeve);
    if (sleeve > 4) { px(0, 9 + 0, 4, 1, 'rgba(0,0,0,0)'); px(0, 17, 4, 1, 'rgba(0,0,0,.15)'); px(12, 17, 4, 1, 'rgba(0,0,0,.15)'); }
  } else {
    px(0, 8, 4, 4, '#3ba7a0');
    px(12, 8, 4, 4, '#3ba7a0');
  }
  px(12, 8, 4, 12, 'rgba(0,0,0,.08)');

  /* ----- umbrella (held on the right) ----- */
  const umL = layers.umbrella;
  if (umL) {
    px(16, -2, 1, 24, '#4a3b2a');
    const S = umL.sample(11, 4);
    [1, 3, 4, 5].forEach((h, i) => tile(S, 5 - h, i, h * 2 + 1, 1, 16 - h, -6 + i, h * 2 + 1, 1));
    px(11, -3, 11, 1, 'rgba(0,0,0,.2)');
  }

  /* ----- head ----- */
  px(4, 0, 8, 8, skin);
  px(4, 7, 8, 1, skinD);

  const hairC = avatar.hair;
  const browC = avatar.hairStyle === 'bald' ? shadeHex(skin, 0.7) : shadeHex(hairC, 0.75);
  switch (avatar.hairStyle) {
    case 'long':
      px(4, 0, 8, 2, hairC); px(4, 2, 2, 1, hairC); px(10, 2, 2, 1, hairC);
      px(4, 2, 1, 8, hairC); px(11, 2, 1, 8, hairC);
      break;
    case 'spiky':
      px(4, 0, 8, 2, hairC); px(4, 2, 1, 2, hairC); px(11, 2, 1, 2, hairC);
      [4, 6, 9, 11].forEach(x => px(x, -1, 1, 1, hairC));
      [5, 10].forEach(x => px(x, -2, 1, 1, hairC));
      break;
    case 'ponytail':
      px(4, 0, 8, 2, hairC); px(4, 2, 2, 1, hairC); px(10, 2, 2, 1, hairC);
      px(4, 2, 1, 2, hairC); px(11, 2, 1, 2, hairC);
      px(12, 2, 1, 6, hairC); px(12, 2, 1, 1, '#e74c3c');
      break;
    case 'bald':
      break;
    default: // short
      px(4, 0, 8, 2, hairC); px(4, 2, 2, 1, hairC); px(10, 2, 2, 1, hairC);
      px(4, 2, 1, 2, hairC); px(11, 2, 1, 2, hairC);
  }
  // face
  px(5, 3, 2, 1, browC); px(9, 3, 2, 1, browC);
  px(5, 4, 1, 1, '#fff'); px(6, 4, 1, 1, avatar.eyes);
  px(9, 4, 1, 1, avatar.eyes); px(10, 4, 1, 1, '#fff');
  px(7, 5, 2, 1, shadeHex(skin, 0.9));
  px(7, 6, 2, 1, shadeHex(skin, 0.72));

  /* ----- accessories ----- */
  const hatL = layers.hat;
  if (hatL) {
    if (hatL.item.warmth >= 3) {       // beanie
      whole(hatL.sample(8, 3), 4, -1, 8, 3);
      px(4, 1, 8, 1, 'rgba(0,0,0,.2)');
      px(7, -2, 2, 1, rgbStr(shade(hatL.color, 1.15)));
    } else {                           // cap
      whole(hatL.sample(8, 2), 4, -1, 8, 2);
      px(3, 1, 10, 1, rgbStr(shade(hatL.color, 0.6)));
    }
  }
  if (layers.sunglasses) {
    px(5, 4, 2, 2, '#111'); px(9, 4, 2, 2, '#111'); px(7, 4, 2, 1, '#111');
    px(4, 4, 1, 1, '#111'); px(11, 4, 1, 1, '#111');
    px(5, 4, 1, 1, '#555'); px(9, 4, 1, 1, '#555');
  }
  const scL = layers.scarf;
  if (scL) {
    whole(scL.sample(8, 2), 4, 8, 8, 2);
    whole(scL.sample(2, 5), 4, 10, 2, 5);
    px(4, 9, 8, 1, 'rgba(0,0,0,.15)');
  }
}

/* =====================================================================
   Weather
   ===================================================================== */
function wmo(code) {
  if (code === 0) return { label: 'Clear sky', icon: '☀️' };
  if (code === 1) return { label: 'Mostly clear', icon: '🌤️' };
  if (code === 2) return { label: 'Partly cloudy', icon: '⛅' };
  if (code === 3) return { label: 'Overcast', icon: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: '🌫️' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: '🌦️' };
  if (code >= 61 && code <= 67) return { label: 'Rain', icon: '🌧️' };
  if (code >= 71 && code <= 77) return { label: 'Snow', icon: '❄️' };
  if (code >= 80 && code <= 82) return { label: 'Rain showers', icon: '🌧️' };
  if (code === 85 || code === 86) return { label: 'Snow showers', icon: '🌨️' };
  if (code >= 95) return { label: 'Thunderstorm', icon: '⛈️' };
  return { label: 'Unknown', icon: '🌡️' };
}
const isSnowCode = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
const unitLabels = units => (units === 'imperial' ? { t: '°F', w: 'mph', p: 'in' } : { t: '°C', w: 'km/h', p: 'mm' });
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
function windLabel(mph) {
  if (mph < 8) return 'Calm';
  if (mph < 15) return 'Light breeze';
  if (mph < 25) return 'Breezy';
  if (mph < 35) return 'Windy';
  return 'Very windy';
}

async function loadWeather() {
  const loc = settings.location;
  if (!loc) return;
  const imp = settings.units === 'imperial';
  $('#weatherBody').innerHTML = '<p class="muted">Loading weather…</p>';
  const params = new URLSearchParams({
    latitude: loc.lat,
    longitude: loc.lon,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max',
    temperature_unit: imp ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imp ? 'mph' : 'kmh',
    precipitation_unit: imp ? 'inch' : 'mm',
    timezone: 'auto',
    forecast_days: 1
  });
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?' + params);
    if (!res.ok) throw new Error('Weather service error');
    const data = await res.json();
    const c = data.current, d = data.daily;
    weather = {
      units: settings.units,
      tempNow: c.temperature_2m, feelsNow: c.apparent_temperature, humidity: c.relative_humidity_2m,
      codeNow: c.weather_code, windNow: c.wind_speed_10m, windDir: c.wind_direction_10m,
      gustNow: c.wind_gusts_10m, isDay: c.is_day === 1,
      hi: d.temperature_2m_max[0], lo: d.temperature_2m_min[0],
      feelsHi: d.apparent_temperature_max[0], feelsLo: d.apparent_temperature_min[0],
      precipSum: d.precipitation_sum[0] ?? 0, precipProb: d.precipitation_probability_max[0] ?? 0,
      snowSum: d.snowfall_sum[0] ?? 0, windMax: d.wind_speed_10m_max[0], gustMax: d.wind_gusts_10m_max[0],
      codeDay: d.weather_code[0]
    };
    renderWeather();
    planOutfit();
    await renderOutfit();
  } catch (err) {
    console.error(err);
    weather = null;
    $('#weatherBody').innerHTML = '<p>Could not load the weather. Check your connection and press ↻.</p>';
  }
}

function renderWeather() {
  const body = $('#weatherBody');
  const w = weather;
  if (!w) { body.innerHTML = '<p class="muted">Pick a location to see today\'s weather.</p>'; return; }
  const u = unitLabels(w.units);
  const cond = wmo(w.codeNow);
  const imp = w.units === 'imperial';
  const mph = imp ? w.windNow : w.windNow / 1.609;
  body.innerHTML = `
    <div class="wx-main">
      <div class="wx-icon" aria-hidden="true">${cond.icon}</div>
      <div>
        <div class="wx-temp">${Math.round(w.tempNow)}${u.t}</div>
        <div class="wx-cond">${esc(cond.label)} · feels ${Math.round(w.feelsNow)}${u.t}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><small>High / Low</small><b>${Math.round(w.hi)}° / ${Math.round(w.lo)}°</b></div>
      <div class="stat"><small>Rain chance</small><b>${Math.round(w.precipProb)}%</b></div>
      <div class="stat"><small>Rain / snow amount</small><b>${w.precipSum.toFixed(imp ? 2 : 1)} ${u.p}</b></div>
      <div class="stat"><small>Humidity</small><b>${Math.round(w.humidity)}%</b></div>
      <div class="stat"><small>Wind · ${windLabel(mph)}</small>
        <b><span class="wind-arrow" style="transform:rotate(${(w.windDir + 180) % 360}deg)">↑</span> ${Math.round(w.windNow)} ${u.w} ${compass(w.windDir)}</b></div>
      <div class="stat"><small>Gusts (max today)</small><b>${Math.round(w.gustMax)} ${u.w}</b></div>
    </div>`;
}

function skyColor() {
  if (!weather) return '#8ecbf0';
  if (!weather.isDay) return '#1d2a4a';
  const c = weather.codeNow;
  if (isSnowCode(c)) return '#dbe7ef';
  if (c >= 51) return '#7d8c99';
  if (c === 3 || c === 45 || c === 48) return '#a9b7c4';
  return '#8ecbf0';
}

/* =====================================================================
   Outfit rules
   ===================================================================== */
function conditions(w) {
  const imp = w.units === 'imperial';
  const F = t => (imp ? t : t * 9 / 5 + 32);
  const mm = p => (imp ? p * 25.4 : p);
  const mph = v => (imp ? v : v / 1.609);
  // "feels like" blend of right now and the day's average
  const eff = F((w.feelsNow + (w.feelsHi + w.feelsLo) / 2) / 2);
  const snow = isSnowCode(w.codeDay) || (w.snowSum > 0 && w.precipProb >= 30);
  const rain = !snow && (w.precipProb >= 50 || mm(w.precipSum) >= 2.5);
  const windy = mph(w.windMax) >= 18 || mph(w.gustMax) >= 28;
  const veryGusty = mph(w.gustMax) >= 30;
  const sunny = w.codeDay <= 2 && !rain && !snow;
  return { eff, snow, rain, windy, veryGusty, sunny, cold: eff <= 45 };
}

const layerTarget = e => (e >= 85 ? 1 : e >= 75 ? 2 : e >= 65 ? 3 : e >= 55 ? 4 : e >= 45 ? 5 : e >= 35 ? 6 : e >= 25 ? 7 : 8);
const legTarget = e => (e >= 80 ? 1 : e >= 62 ? 2 : e >= 45 ? 3 : e >= 30 ? 4 : 5);
const shoeTarget = e => (e >= 80 ? 1 : e >= 55 ? 2 : e >= 40 ? 3 : 4);
const feelWord = e => (e >= 85 ? 'Hot' : e >= 75 ? 'Warm' : e >= 65 ? 'Mild' : e >= 55 ? 'Cool' : e >= 45 ? 'Chilly' : e >= 35 ? 'Cold' : e >= 25 ? 'Very cold' : 'Freezing');

/* Pick the best item in a category: closest warmth, with a little randomness so "New outfit" varies */
function pick(slot, target, { wp = false } = {}) {
  const items = byCat(slot);
  if (!items.length) return null;
  let best = null;
  for (const it of items) {
    let s = Math.abs(it.warmth - target) * 2 + Math.random() * 1.1;
    if (wp && !it.waterproof) s += 2.5;
    if (!best || s < best.s) best = { it, s };
  }
  return best.it;
}

function planOutfit() {
  if (!weather) {
    outfit = {};
    outfitNotes = ['Set a location to get a weather-based outfit.'];
    return;
  }
  const c = conditions(weather);
  const u = unitLabels(weather.units);
  const imp = weather.units === 'imperial';
  const effShown = imp ? c.eff : (c.eff - 32) * 5 / 9;
  const next = {};
  const notes = [];
  notes.push(`${feelWord(c.eff)} day — feels like about ${Math.round(effShown)}${u.t}.`);

  /* top + jacket: choose the pair whose combined warmth is closest to the target */
  const tops = byCat('top'), outers = byCat('outerwear');
  const target = layerTarget(c.eff);
  let best = null;
  for (const t of (tops.length ? tops : [null])) {
    for (const o of [null, ...outers]) {
      const sum = (t ? t.warmth : 2) + (o ? o.warmth : 0);
      let s = Math.abs(sum - target) * 2 + Math.random() * 1.1;
      if ((c.rain || c.snow) && outers.length) {
        if (!o) s += 2;
        else if (!o.waterproof) s += 2;
      }
      if (!best || s < best.s) best = { t, o, s };
    }
  }
  if (best.t) next.top = best.t.id;
  if (best.o) next.outerwear = best.o.id;

  const wet = c.rain || c.snow;
  const bottom = pick('bottom', legTarget(c.eff));
  const shoes = pick('shoes', shoeTarget(c.eff), { wp: wet });
  if (bottom) next.bottom = bottom.id;
  if (shoes) next.shoes = shoes.id;

  /* accessories */
  let hat = null;
  if (c.eff <= 42 || c.snow) hat = pick('hat', c.eff < 28 ? 5 : 4);
  else if (c.sunny && c.eff >= 70 && Math.random() < 0.6) hat = pick('hat', 1);
  if (hat) next.hat = hat.id;

  if (c.eff <= 36 || (c.eff <= 48 && c.windy)) {
    const scarf = pick('scarf', c.eff <= 28 ? 5 : 3);
    if (scarf) next.scarf = scarf.id;
  }
  if (c.sunny && c.eff >= 40) {
    const sg = pick('sunglasses', 3);
    if (sg) next.sunglasses = sg.id;
  }
  if (c.rain && !c.veryGusty) {
    const um = pick('umbrella', 3);
    if (um) next.umbrella = um.id;
  }

  /* explanations */
  if (c.rain) notes.push(`Rain likely (${Math.round(weather.precipProb)}% chance) — waterproof pieces were picked first.`);
  if (c.snow) notes.push('Snow expected — warm, waterproof shoes and a hat help.');
  if (c.windy) notes.push(`Windy — gusts up to ${Math.round(weather.gustMax)} ${u.w}.${c.rain && c.veryGusty ? ' Too gusty for an umbrella.' : ''}`);
  if (c.sunny && c.eff >= 40) notes.push('Sunny — sunglasses recommended.');

  /* friendly tips when the closet is missing something useful */
  const missing = REQUIRED_SLOTS.filter(s => !byCat(s).length);
  if (missing.length) notes.push(`No ${missing.map(s => CATEGORIES[s].label.toLowerCase()).join(', ')} in your closet yet — a basic placeholder is shown.`);
  if (wet && !closet.some(i => i.waterproof && (i.category === 'outerwear' || i.category === 'shoes'))) notes.push('Tip: add a waterproof jacket or shoes for wet days.');
  if (c.cold && !outers.length) notes.push('Tip: add a warm jacket to your closet for cold days.');

  outfit = next;
  outfitNotes = notes;
}

function resolveSlots() {
  const slots = {};
  for (const slot of SLOT_ORDER) {
    const item = closet.find(i => i.id === outfit[slot]);
    if (item && item.category === slot) slots[slot] = item;
  }
  return slots;
}

async function renderOutfit() {
  const slots = resolveSlots();
  const rows = SLOT_ORDER.filter(s => slots[s]).map(s => {
    const it = slots[s];
    const removable = !REQUIRED_SLOTS.includes(s);
    return `<li class="outfit-row">
      <img src="${it.image}" alt="">
      <div class="outfit-txt"><b>${esc(it.name)}</b><small>${CATEGORIES[s].icon} ${CATEGORIES[s].label}</small></div>
      <div class="outfit-btns">
        <button class="mc-btn mini" type="button" data-act="cycle" data-slot="${s}" title="Swap for another">↻</button>
        ${removable ? `<button class="mc-btn mini" type="button" data-act="remove" data-slot="${s}" title="Take off">✕</button>` : ''}
      </div></li>`;
  });
  $('#outfitList').innerHTML = rows.length ? rows.join('') : '<li class="muted">No pieces yet — add photos in the Closet tab.</li>';
  $('#outfitNotes').innerHTML = outfitNotes.map(n => `<li>${esc(n)}</li>`).join('');
  await renderAvatar($('#outfitCanvas'), settings.avatar, slots, skyColor());
}

async function renderAvatarTab() {
  const label = settings.avatar.name || 'Your avatar';
  $('#avatarNameLabel').textContent = label;
  await renderAvatar($('#avatarCanvas'), settings.avatar, resolveSlots(), '#8ecbf0');
}

/* =====================================================================
   Closet UI
   ===================================================================== */
function buildCategoryControls() {
  const opts = Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${v.icon} ${v.label}</option>`).join('');
  $('#itemCategory').innerHTML = opts;
  $('#filterCat').innerHTML = '<option value="all">Everything</option>' + opts;
}

function renderCloset() {
  const filter = $('#filterCat').value || 'all';
  $('#closetCount').textContent = closet.length;
  $('#closetEmpty').hidden = closet.length > 0;
  const items = closet
    .filter(i => filter === 'all' || i.category === filter)
    .sort((a, b) => (b.added || 0) - (a.added || 0));
  $('#closetGrid').innerHTML = items.map(it => {
    const cat = CATEGORIES[it.category];
    const heat = NO_WARMTH.includes(it.category) ? '' :
      `<span class="heat" title="Warmth ${it.warmth}/5">${[1, 2, 3, 4, 5].map(n => `<i class="${n <= it.warmth ? 'on' : ''}"></i>`).join('')}</span>`;
    return `<div class="slot-card">
      <img src="${it.image}" alt="${esc(it.name)}">
      <div class="slot-name">${esc(it.name)}</div>
      <div class="slot-meta"><span>${cat.icon} ${cat.label}${it.waterproof ? ' 💧' : ''}</span>${heat}</div>
      <div class="slot-actions">
        <button class="mc-btn mini" type="button" data-act="tryon" data-id="${it.id}">Try on</button>
        <button class="mc-btn mini" type="button" data-act="edit" data-id="${it.id}">Edit</button>
        <button class="mc-btn mini danger" type="button" data-act="delete" data-id="${it.id}">✕</button>
      </div>
    </div>`;
  }).join('');
}

function syncItemFields() {
  const c = $('#itemCategory').value;
  $('#warmthField').hidden = NO_WARMTH.includes(c);
  $('#waterproofField').hidden = NO_WATERPROOF.includes(c);
  const w = $('#itemWarmth').value;
  $('#warmthLabel').textContent = `${w} – ${WARMTH_LABELS[w]}`;
}

function openItemDialog(item) {
  editingId = item ? item.id : null;
  pendingImage = null;
  $('#dialogTitle').textContent = item ? 'Edit Item' : 'Add to Closet';
  $('#itemName').value = item ? item.name : '';
  $('#itemCategory').value = item ? item.category : 'top';
  $('#itemWarmth').value = item ? item.warmth : 3;
  $('#itemWaterproof').checked = item ? !!item.waterproof : false;
  const prev = $('#itemPreview');
  if (item) { prev.src = item.image; prev.hidden = false; }
  else { prev.removeAttribute('src'); prev.hidden = true; }
  $('#itemPhoto').value = '';
  $('#saveAnotherBtn').hidden = !!item;
  syncItemFields();
  const dlg = $('#itemDialog');
  if (!dlg.open) dlg.showModal();
}

async function onPhotoChosen(file) {
  if (!file) return;
  try {
    pendingImage = await fileToResizedDataURL(file);
    const prev = $('#itemPreview');
    prev.src = pendingImage;
    prev.hidden = false;
    if (!$('#itemName').value.trim()) {
      $('#itemName').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 40);
    }
  } catch (e) {
    showToast(e.message);
  }
}

async function saveItem(addAnother) {
  if (!editingId && !pendingImage) { showToast('Choose a photo first'); return; }
  const category = $('#itemCategory').value;
  const existing = editingId ? closet.find(i => i.id === editingId) : null;
  const item = {
    ...(existing || {}),
    name: $('#itemName').value.trim() || CATEGORIES[category].label,
    category,
    warmth: NO_WARMTH.includes(category) ? 3 : +$('#itemWarmth').value,
    waterproof: category === 'umbrella' || (!NO_WATERPROOF.includes(category) && $('#itemWaterproof').checked),
    image: pendingImage || existing.image,
    added: existing ? existing.added : Date.now()
  };
  try {
    const key = await dbPut(item);
    if (!existing) item.id = key;
  } catch (e) {
    console.error(e);
    showToast('Could not save — browser storage may be blocked.');
    return;
  }
  imgCache.delete(item.id);
  closet = existing ? closet.map(i => (i.id === item.id ? item : i)) : [...closet, item];
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await afterClosetChange();
  showToast(existing ? 'Item updated' : 'Added to closet');
  if (addAnother && !existing) openItemDialog(); else $('#itemDialog').close();
}

async function deleteItem(id) {
  const item = closet.find(i => i.id === id);
  if (!item || !confirm(`Remove "${item.name}" from your closet?`)) return;
  try { await dbDelete(id); } catch (e) { console.error(e); showToast('Could not delete that item.'); return; }
  imgCache.delete(id);
  closet = closet.filter(i => i.id !== id);
  await afterClosetChange();
}

async function afterClosetChange() {
  renderCloset();
  renderSetup();
  if (weather) planOutfit(); else { outfit = {}; outfitNotes = ['Set a location to get a weather-based outfit.']; }
  await renderOutfit();
}

/* Backup / restore */
function exportCloset() {
  const data = { app: 'blockfit', version: 1, exported: new Date().toISOString(), settings, closet };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `blockfit-closet-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importCloset(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.closet)) throw new Error('bad file');
    const clean = data.closet
      .filter(i => i && typeof i.image === 'string' && i.image.startsWith('data:image/') && CATEGORIES[i.category])
      .map(i => ({
        name: String(i.name || CATEGORIES[i.category].label).slice(0, 40),
        category: i.category,
        warmth: Math.min(5, Math.max(1, Math.round(+i.warmth) || 3)),
        waterproof: !!i.waterproof,
        image: i.image,
        added: +i.added || Date.now()
      }));
    if (!confirm(`Import ${clean.length} item(s)? This replaces your current closet.`)) return;
    await dbClear();
    for (const it of clean) await dbPut(it);
    closet = await dbAll();
    imgCache.clear();
    if (data.settings) {
      const prevLoc = settings.location;
      settings = sanitizeSettings(data.settings);
      if (!settings.location) settings.location = prevLoc;
      saveSettings();
      syncUnitsUI(); syncAvatarUI(); syncLocationUI();
    }
    await afterClosetChange();
    await renderAvatarTab();
    if (settings.location) await loadWeather();
    showToast('Closet imported');
  } catch (e) {
    console.error(e);
    showToast("That file isn't a BlockFit backup.");
  }
}

/* =====================================================================
   Location
   ===================================================================== */
function syncLocationUI() {
  $('#locCurrent').textContent = settings.location ? `📍 ${settings.location.name}` : '';
}
function syncUnitsUI() { $('#unitsSelect').value = settings.units; }

async function searchCity(q) {
  const list = $('#locResults');
  list.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
    if (!res.ok) throw new Error('search failed');
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) { list.innerHTML = '<li class="muted">No matches. Try a different spelling.</li>'; return; }
    list.innerHTML = results.map((r, i) => {
      const label = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ');
      return `<li><button class="mc-btn mini" type="button" data-i="${i}">${esc(label)}</button></li>`;
    }).join('');
    list._results = results;
  } catch (e) {
    console.error(e);
    list.innerHTML = '<li>Search failed. Check your connection and try again.</li>';
  }
}

async function setLocation(loc) {
  settings.location = loc;
  saveSettings();
  syncLocationUI();
  renderSetup();
  $('#locResults').innerHTML = '';
  await loadWeather();
}

function useMyLocation() {
  if (!navigator.geolocation) { showToast('Location is not supported in this browser.'); return; }
  showToast('Asking your device for location…');
  navigator.geolocation.getCurrentPosition(
    pos => setLocation({ name: 'My location', lat: +pos.coords.latitude.toFixed(3), lon: +pos.coords.longitude.toFixed(3) }),
    () => showToast('Could not get your location. Try searching for a city instead.'),
    { timeout: 10000 }
  );
}

/* =====================================================================
   Avatar customizer
   ===================================================================== */
function makeSwatches(sel, colors, key) {
  const box = $(sel);
  box.innerHTML = colors.map(c => `<button type="button" class="swatch" data-color="${c}" style="background:${c}" aria-label="${key} ${c}"></button>`).join('');
  box.addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (b) updateAvatar({ [key]: b.dataset.color });
  });
}
function syncAvatarUI() {
  const a = settings.avatar;
  $$('#skinSwatches .swatch').forEach(b => b.classList.toggle('is-selected', b.dataset.color === a.skin));
  $$('#hairSwatches .swatch').forEach(b => b.classList.toggle('is-selected', b.dataset.color === a.hair));
  $$('#eyeSwatches .swatch').forEach(b => b.classList.toggle('is-selected', b.dataset.color === a.eyes));
  $('#hairStyle').value = a.hairStyle;
  if (document.activeElement !== $('#avatarName')) $('#avatarName').value = a.name;
}
function updateAvatar(patch) {
  Object.assign(settings.avatar, patch);
  settings.avatarEdited = true;
  saveSettings();
  syncAvatarUI();
  renderSetup();
  renderAvatarTab();
  renderOutfit();
}

/* =====================================================================
   Setup checklist
   ===================================================================== */
function renderSetup() {
  const cats = new Set(closet.map(i => i.category));
  const hasBasics = REQUIRED_SLOTS.every(c => cats.has(c));
  const steps = [
    { done: !!settings.location, text: 'Choose your location', btn: 'Set location', go: 'location' },
    { done: hasBasics, text: closet.length ? 'Add at least a top, bottom and shoes' : 'Add photos of your clothes', btn: 'Open closet', go: 'closet' },
    { done: !!settings.avatarEdited, text: 'Customize your avatar', btn: 'Make avatar', go: 'avatar' }
  ];
  $('#setupCard').hidden = steps.every(s => s.done);
  $('#setupList').innerHTML = steps.map(s => `
    <li class="${s.done ? 'done' : ''}">
      <span class="step-text">${s.done ? '✅' : '⬜'} ${esc(s.text)}</span>
      ${s.done ? '' : `<button class="mc-btn mini" type="button" data-go="${s.go}">${s.btn}</button>`}
    </li>`).join('');
}

/* =====================================================================
   Tabs + events
   ===================================================================== */
function showTab(name) {
  $$('.tab').forEach(b => b.classList.toggle('is-active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('is-active', p.id === 'tab-' + name));
  if (name === 'closet') renderCloset();
  if (name === 'avatar') renderAvatarTab();
  if (name === 'home') renderOutfit();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bindUI() {
  $$('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // setup checklist
  $('#setupList').addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    if (b.dataset.go === 'location') { showTab('home'); $('#cityInput').focus(); }
    else showTab(b.dataset.go);
  });

  // location
  $('#locForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#cityInput').value.trim();
    if (q) searchCity(q);
  });
  $('#locResults').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    const r = $('#locResults')._results[+b.dataset.i];
    const name = [r.name, r.admin1, r.country_code].filter(Boolean).join(', ');
    setLocation({ name, lat: r.latitude, lon: r.longitude });
  });
  $('#geoBtn').addEventListener('click', useMyLocation);
  $('#unitsSelect').addEventListener('change', e => {
    settings.units = e.target.value === 'metric' ? 'metric' : 'imperial';
    saveSettings();
    if (settings.location) loadWeather();
  });
  $('#refreshBtn').addEventListener('click', () => {
    if (settings.location) loadWeather(); else showToast('Pick a location first');
  });

  // outfit
  $('#shuffleBtn').addEventListener('click', () => {
    if (!weather) { showToast('Pick a location first'); return; }
    if (!closet.length) { showToast('Add some clothes to your closet first'); return; }
    planOutfit();
    renderOutfit();
  });
  $('#saveImgBtn').addEventListener('click', () => {
    $('#outfitCanvas').toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `blockfit-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });
  $('#outfitList').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const slot = b.dataset.slot;
    if (b.dataset.act === 'remove') delete outfit[slot];
    if (b.dataset.act === 'cycle') {
      const items = byCat(slot);
      if (!items.length) return;
      const idx = items.findIndex(i => i.id === outfit[slot]);
      outfit[slot] = items[(idx + 1) % items.length].id;
    }
    renderOutfit();
  });

  // closet
  $('#addItemBtn').addEventListener('click', () => openItemDialog());
  $('#filterCat').addEventListener('change', renderCloset);
  $('#closetGrid').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = +b.dataset.id;
    const item = closet.find(i => i.id === id);
    if (!item) return;
    if (b.dataset.act === 'edit') openItemDialog(item);
    if (b.dataset.act === 'delete') deleteItem(id);
    if (b.dataset.act === 'tryon') {
      outfit[item.category] = id;
      showTab('home');
      showToast(`Trying on: ${item.name}`);
    }
  });
  $('#exportBtn').addEventListener('click', exportCloset);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', e => {
    if (e.target.files[0]) importCloset(e.target.files[0]);
    e.target.value = '';
  });

  // item dialog
  $('#itemPhoto').addEventListener('change', e => onPhotoChosen(e.target.files[0]));
  $('#itemCategory').addEventListener('change', syncItemFields);
  $('#itemWarmth').addEventListener('input', syncItemFields);
  $('#itemForm').addEventListener('submit', e => { e.preventDefault(); saveItem(false); });
  $('#saveAnotherBtn').addEventListener('click', () => saveItem(true));
  $('#cancelItem').addEventListener('click', () => $('#itemDialog').close());

  // avatar
  makeSwatches('#skinSwatches', SKIN_TONES, 'skin');
  makeSwatches('#hairSwatches', HAIR_COLORS, 'hair');
  makeSwatches('#eyeSwatches', EYE_COLORS, 'eyes');
  $('#hairStyle').addEventListener('change', e => updateAvatar({ hairStyle: e.target.value }));
  $('#avatarName').addEventListener('input', e => updateAvatar({ name: e.target.value.slice(0, 16) }));
}

/* =====================================================================
   Start
   ===================================================================== */
async function init() {
  buildCategoryControls();
  bindUI();
  syncUnitsUI();
  syncAvatarUI();
  syncLocationUI();
  try {
    closet = await dbAll();
  } catch (e) {
    console.error(e);
    showToast("Browser storage is unavailable, so your closet won't be saved.");
  }
  renderCloset();
  renderSetup();
  outfitNotes = ['Set a location to get a weather-based outfit.'];
  await renderOutfit();
  if (settings.location) await loadWeather();
}

document.addEventListener('DOMContentLoaded', init);
