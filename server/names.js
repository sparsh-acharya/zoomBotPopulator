// server/names.js
// Generates random full Indian names for bots, with a configurable male ratio.

const MALE_FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna',
  'Ishaan', 'Rohan', 'Kabir', 'Aryan', 'Dhruv', 'Karan', 'Nikhil', 'Rahul',
  'Amit', 'Manish', 'Siddharth', 'Varun', 'Rohit', 'Aniket', 'Harsh', 'Yash', 'Tarun',
];

const FEMALE_FIRST_NAMES = [
  'Ananya', 'Aadhya', 'Diya', 'Saanvi', 'Aarohi', 'Anika', 'Navya', 'Myra',
  'Sara', 'Riya', 'Priya', 'Neha', 'Pooja', 'Sneha', 'Kavya', 'Meera', 'Isha',
  'Tara', 'Nisha', 'Divya', 'Aditi', 'Shreya', 'Ishita', 'Naina', 'Pari',
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Kumar', 'Reddy', 'Nair',
  'Iyer', 'Menon', 'Rao', 'Joshi', 'Desai', 'Mehta', 'Shah', 'Chopra',
  'Kapoor', 'Malhotra', 'Bose', 'Banerjee', 'Mukherjee', 'Chatterjee',
  'Pillai', 'Naidu', 'Agarwal', 'Mishra', 'Pandey', 'Yadav', 'Bhat', 'Kulkarni',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @param {'male'|'female'} [gender] - omit for a 50/50 random gender
 * @returns {string} e.g. "Aarav Sharma"
 */
export function randomIndianName(gender) {
  let pool;
  if (gender === 'male') pool = MALE_FIRST_NAMES;
  else if (gender === 'female') pool = FEMALE_FIRST_NAMES;
  else pool = Math.random() < 0.5 ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES;
  return `${pick(pool)} ${pick(LAST_NAMES)}`;
}

/**
 * Generate `count` names where roughly `maleRatio`% are male, shuffled.
 * @param {number} count
 * @param {number} [maleRatio=50] - 0..100
 * @returns {string[]}
 */
export function generateNames(count, maleRatio = 50) {
  const ratio = clamp(Number(maleRatio), 0, 100);
  const maleCount = Math.round((count * ratio) / 100);
  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(randomIndianName(i < maleCount ? 'male' : 'female'));
  }
  // Shuffle so males/females aren't grouped (Fisher–Yates).
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names;
}
