// server/names.js
// Generates random full Indian names for bots to join meetings with.

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Krishna',
  'Ishaan', 'Rohan', 'Kabir', 'Aryan', 'Dhruv', 'Karan', 'Nikhil', 'Rahul',
  'Amit', 'Manish', 'Siddharth', 'Varun', 'Ananya', 'Aadhya', 'Diya', 'Saanvi',
  'Aarohi', 'Anika', 'Navya', 'Myra', 'Sara', 'Riya', 'Priya', 'Neha', 'Pooja',
  'Sneha', 'Kavya', 'Meera', 'Isha', 'Tara', 'Nisha', 'Divya',
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

/** @returns {string} e.g. "Aarav Sharma" */
export function randomIndianName() {
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}
