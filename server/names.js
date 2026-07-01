// server/names.js
// Generates random full Indian names for bots from large CSV pools, split by
// religious group. A first name is ALWAYS paired with a surname from the SAME
// group (e.g. a Hindu first name only ever gets a Hindu surname — never a Muslim
// one). Names come from server/data/<group>_<male|female|last>.csv.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');

const RELIGIONS = ['hindu', 'muslim', 'christian'];

// Religion mix used when none is requested. Roughly tracks India's population
// share so a random batch looks realistic (normalized, not exact census data).
const RELIGION_WEIGHTS = { hindu: 0.72, muslim: 0.18, christian: 0.1 };

// ── Load CSV pools once at module load ────────────────────────────────────────
function loadCsv(file) {
  const text = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.toLowerCase() !== 'name'); // drop header + blanks
}

// NAMES[religion] = { male: [...], female: [...], last: [...] }
const NAMES = {};
for (const religion of RELIGIONS) {
  NAMES[religion] = {
    male: loadCsv(`${religion}_male.csv`),
    female: loadCsv(`${religion}_female.csv`),
    last: loadCsv(`${religion}_last.csv`),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// Fisher–Yates — returns a NEW shuffled array (does not mutate the input).
function shuffled(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Pick a religion at random, weighted by RELIGION_WEIGHTS.
function weightedReligion() {
  const r = Math.random();
  let acc = 0;
  for (const religion of RELIGIONS) {
    acc += RELIGION_WEIGHTS[religion];
    if (r < acc) return religion;
  }
  return RELIGIONS[0];
}

/**
 * One random full name. First + surname always come from the same religion.
 * @param {'male'|'female'} [gender]   - omit for a 50/50 random gender
 * @param {'hindu'|'muslim'|'christian'} [religion] - omit for a weighted pick
 * @returns {string} e.g. "Aarav Sharma"
 */
export function randomIndianName(gender, religion) {
  const rel = RELIGIONS.includes(religion) ? religion : weightedReligion();
  const g = gender === 'male' || gender === 'female' ? gender : pick(['male', 'female']);
  return `${pick(NAMES[rel][g])} ${pick(NAMES[rel].last)}`;
}

/**
 * Generate `count` names where roughly `maleRatio`% are male. Religion is chosen
 * per name by RELIGION_WEIGHTS, and first/last always match that religion.
 *
 * To avoid the repetition seen with small lists, names are drawn per
 * religion+gender bucket using a shuffled first-name pool (so first names don't
 * repeat until the whole pool is used up), each paired with a same-group surname
 * chosen to keep the full name unique within the batch.
 *
 * @param {number} count
 * @param {number} [maleRatio=50] - 0..100
 * @returns {string[]}
 */
export function generateNames(count, maleRatio = 50) {
  const ratio = clamp(Number(maleRatio), 0, 100);
  const maleCount = Math.round((count * ratio) / 100);

  // 1. Assign a gender (by ratio) and religion (weighted) to each slot.
  const buckets = new Map(); // "religion|gender" -> how many names needed
  for (let i = 0; i < count; i++) {
    const gender = i < maleCount ? 'male' : 'female';
    const religion = weightedReligion();
    const key = `${religion}|${gender}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  // 2. Fill each bucket with unique first names + same-group surnames.
  const names = [];
  for (const [key, needed] of buckets) {
    const [religion, gender] = key.split('|');
    const firsts = shuffled(NAMES[religion][gender]); // unique until exhausted
    const lasts = NAMES[religion].last;
    const usedFull = new Set();
    for (let j = 0; j < needed; j++) {
      const first = firsts[j % firsts.length];
      let full;
      let attempts = 0;
      do {
        full = `${first} ${pick(lasts)}`;
      } while (usedFull.has(full) && ++attempts < 50);
      usedFull.add(full);
      names.push(full);
    }
  }

  // 3. Shuffle so genders/religions interleave instead of being grouped.
  return shuffled(names);
}
