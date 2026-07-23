// fetch_stats.js — Collecte quotidienne pour l'écran Statistiques
// Node >= 20 (fetch natif), zéro dépendance.
// Usage : node fetch_stats.js
// Sortie : docs/data_stats.json (à servir via GitHub Pages)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

// ---------------------------------------------------------------
// Configuration : stations suivies (id → libellé court)
// ---------------------------------------------------------------
const STATIONS = {
  "81380001": "Leclerc Lescure",
  "81130001": "Interm. Cagnac",
  "81150003": "Total Marssac",
};
const FUELS = ["gazole", "e10", "sp98", "e85"];
const HISTORY_DAYS = 90; // profondeur conservée
const CHART_POINTS = 60; // points max dessinés
const CHART_W = 420, CHART_H = 130; // viewBox du graphique SVG

const ODS =
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records";

// ---------------------------------------------------------------
// 1. Prix du jour pour chaque station
// ---------------------------------------------------------------
async function fetchStationPrices() {
  const ids = Object.keys(STATIONS)
    .map((id) => `id=${id}`)
    .join(" OR ");
  const url = `${ODS}?where=${encodeURIComponent(ids)}&select=id,ville,gazole_prix,e10_prix,sp98_prix,e85_prix,gazole_maj&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ODS HTTP ${res.status}`);
  const json = await res.json();
  const out = {};
  for (const r of json.results) {
    out[String(r.id)] = {
      gazole: r.gazole_prix ?? null,
      e10: r.e10_prix ?? null,
      sp98: r.sp98_prix ?? null,
      e85: r.e85_prix ?? null,
    };
  }
  return out;
}

// ---------------------------------------------------------------
// 2. Brent (Yahoo Finance BZ=F) — historique 3 mois inclus
// ---------------------------------------------------------------
async function fetchBrent() {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?range=3mo&interval=1d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart.result[0];
  const dates = r.timestamp.map((t) =>
    new Date(t * 1000).toISOString().slice(0, 10)
  );
  const closes = r.indicators.quote[0].close.map((c) =>
    c == null ? null : Math.round(c * 100) / 100
  );
  return { dates, closes };
}

// ---------------------------------------------------------------
// Helpers stats
// ---------------------------------------------------------------
function pctChange(series, days) {
  const clean = series.filter((v) => v != null);
  if (clean.length < 2) return null;
  const recent = clean[clean.length - 1];
  const past = clean[Math.max(0, clean.length - 1 - days)];
  if (!past) return null;
  return Math.round(((recent - past) / past) * 1000) / 10; // % à 1 décimale
}

function pearson(xs, ys) {
  const pairs = xs
    .map((x, i) => [x, ys[i]])
    .filter(([x, y]) => x != null && y != null);
  const n = pairs.length;
  if (n < 8) return null; // pas assez de points pour être honnête
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (const [x, y] of pairs) {
    num += (x - mx) * (y - my);
    dx += (x - mx) ** 2;
    dy += (y - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return Math.round((num / Math.sqrt(dx * dy)) * 100) / 100;
}

// Météo prédictive (heuristique, PAS une prévision financière) :
// les prix à la pompe suivent le Brent avec ~1 à 3 semaines de retard.
// Signal = variation Brent 14 j − variation pompe 14 j.
function meteo(brentPct14, pumpPct14) {
  if (brentPct14 == null || pumpPct14 == null)
    return { icone: "?", tendance: "Historique insuffisant", proba: null };
  const signal = brentPct14 - pumpPct14;
  const proba = Math.min(85, Math.max(15, Math.round(50 + signal * 5)));
  if (signal > 3)
    return { icone: "🌧", tendance: "Hausse probable (2 sem.)", proba };
  if (signal < -3)
    return { icone: "☀", tendance: "Baisse probable (2 sem.)", proba: 100 - proba };
  return { icone: "⛅", tendance: "Stable", proba: null };
}

// Polyline SVG précalculée (le template Liquid n'a plus qu'à l'injecter)
function toPolyline(series, w = CHART_W, h = CHART_H) {
  const pts = series
    .map((v, i) => [i, v])
    .filter(([, v]) => v != null)
    .slice(-CHART_POINTS);
  if (pts.length < 2) return { points: "", min: null, max: null };
  const vals = pts.map(([, v]) => v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const n = pts.length;
  const str = pts
    .map(([_, v], i) => {
      const x = Math.round((i / (n - 1)) * w);
      const y = Math.round(h - ((v - min) / span) * h);
      return `${x},${y}`;
    })
    .join(" ");
  return { points: str, min, max };
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
const HISTORY_FILE = "history.json";
const OUT_FILE = "docs/data_stats.json";

const today = new Date().toISOString().slice(0, 10);

let history = {};
if (existsSync(HISTORY_FILE)) {
  history = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
}

const [prices, brent] = await Promise.all([fetchStationPrices(), fetchBrent()]);

// Enregistrer la mesure du jour (une par jour max, écrase si relancé)
for (const id of Object.keys(STATIONS)) {
  history[id] ??= {};
  history[id][today] = prices[id] ?? { gazole: null, e10: null, sp98: null, e85: null };
  // Purge au-delà de HISTORY_DAYS
  const dates = Object.keys(history[id]).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - HISTORY_DAYS)))
    delete history[id][d];
}
writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 1));

// Variation Brent 14 j (jours ouvrés ≈ 10 points)
const brentPct14 = pctChange(brent.closes, 10);
const brentChart = toPolyline(brent.closes);

// Construire la sortie par station
const stationsOut = {};
for (const [id, name] of Object.entries(STATIONS)) {
  const dates = Object.keys(history[id] ?? {}).sort();
  const series = {};
  for (const f of FUELS) series[f] = dates.map((d) => history[id][d][f] ?? null);

  // Aligner le Brent sur les mêmes dates (pour la corrélation)
  const brentAligned = dates.map((d) => {
    const i = brent.dates.indexOf(d);
    return i >= 0 ? brent.closes[i] : null;
  });

  const fuels = {};
  for (const f of FUELS) {
    const chart = toPolyline(series[f]);
    fuels[f] = {
      last: series[f].filter((v) => v != null).at(-1) ?? null,
      d7: pctChange(series[f], 7),
      d14: pctChange(series[f], 14),
      d30: pctChange(series[f], 30),
      chart_points: chart.points,
      chart_min: chart.min,
      chart_max: chart.max,
      correl_brent: pearson(brentAligned, series[f]),
    };
  }

  stationsOut[id] = {
    name,
    n_days: dates.length,
    fuels,
    meteo: meteo(brentPct14, fuels.gazole.d14),
  };
}

mkdirSync("docs", { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      updated: new Date().toISOString(),
      brent: {
        last: brent.closes.filter((v) => v != null).at(-1),
        d14_pct: brentPct14,
        chart_points: brentChart.points,
        chart_min: brentChart.min,
        chart_max: brentChart.max,
      },
      chart_w: CHART_W,
      chart_h: CHART_H,
      stations: stationsOut,
    },
    null,
    1
  )
);

console.log(`OK — ${Object.keys(stationsOut).length} stations, Brent ${brent.closes.at(-1)} $`);
