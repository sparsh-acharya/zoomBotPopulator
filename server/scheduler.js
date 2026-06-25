// server/scheduler.js
// In-memory scheduler for "presentation" jobs: at the chosen time, a job fires
// and a host bot is launched to start the meeting and play the uploaded video.
//
// Consistent with the rest of this app, state lives in memory (a Map) and a
// plain setTimeout drives each job. This means scheduled jobs do NOT survive a
// server restart — acceptable for a single-operator tool; persistence can be
// layered on later without changing this interface.

import { v4 as uuidv4 } from 'uuid';

const JOB_ID_LENGTH = 8;
// setTimeout uses a signed 32-bit ms delay; anything larger fires immediately.
// Cap how far ahead we schedule so a far-future time doesn't silently misfire.
const MAX_DELAY_MS = 2_147_483_647; // ~24.8 days
// If a job's start time is already past (or within this window), fire promptly.
const IMMEDIATE_THRESHOLD_MS = 1_000;

// Map<jobId, Job>. Job timers are kept on the record so cancel() can clear them.
const jobs = new Map();

// The function the scheduler calls when a job fires. Injected by index.js so
// this module stays free of Zoom/Playwright concerns. Signature: (job) => void.
let fireHandler = null;

// Resolver injected by index.js: (botId) => bot status string | null. Used to
// detect when a running job's bot has ended so the job can be pruned.
let botStatusResolver = null;

// We only ever keep jobs that are upcoming or live; anything else is pruned.
const ACTIVE_JOB_STATUSES = new Set(['scheduled', 'starting', 'running']);
// A running job whose bot reports one of these has ended — drop the job.
const TERMINAL_BOT_STATUSES = new Set([
  'left-timer',
  'left-meeting-ended',
  'left-manual',
  'left-removed',
  'error',
]);

/** Register the callback invoked when a job's start time arrives. */
export function onFire(handler) {
  fireHandler = handler;
}

/** Register a (botId) => status resolver used to prune finished jobs. */
export function setBotStatusResolver(fn) {
  botStatusResolver = fn;
}

// Called with the job whenever it leaves the store (cancel / end / prune), so
// index.js can clean up its uploaded video. Injected to keep fs out of here.
let removeHandler = null;

/** Register a (job) => void callback fired whenever a job is removed. */
export function onRemove(fn) {
  removeHandler = fn;
}

/**
 * Create and arm a scheduled job.
 * @param {object} input
 * @param {string} input.topic
 * @param {string} input.startTime - ISO8601
 * @param {number} input.durationMinutes
 * @param {string} input.videoUrl - server-relative URL to the uploaded video
 * @param {string} input.meetingNumber
 * @param {string} input.password
 * @param {string} input.joinUrl
 * @returns {object} the stored job
 */
export function schedule(input) {
  const id = uuidv4().slice(0, JOB_ID_LENGTH);
  const job = {
    id,
    topic: input.topic,
    startTime: input.startTime,
    durationMinutes: input.durationMinutes,
    endBehavior: input.endBehavior || 'loop',
    videoUrl: input.videoUrl,
    meetingNumber: input.meetingNumber,
    password: input.password,
    joinUrl: input.joinUrl,
    status: 'scheduled', // scheduled | starting | running | done | error | canceled
    botId: null,
    error: null,
    createdAt: new Date().toISOString(),
    firedAt: null,
    _timer: null,
  };
  jobs.set(id, job);
  arm(job);
  // Return the serializable view — the live record holds a Timeout (_timer)
  // that JSON.stringify can't handle (circular).
  return toPublic(job);
}

function arm(job) {
  const delay = new Date(job.startTime).getTime() - Date.now();
  const clamped = Math.min(Math.max(delay, IMMEDIATE_THRESHOLD_MS), MAX_DELAY_MS);
  job._timer = setTimeout(() => fire(job.id), clamped);
}

async function fire(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'scheduled') return;
  job.status = 'starting';
  job.firedAt = new Date().toISOString();
  job._timer = null;
  if (!fireHandler) {
    job.status = 'error';
    job.error = 'No fire handler registered';
    return;
  }
  try {
    await fireHandler(job);
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
  }
}

/** Cancel a not-yet-fired job (removes it entirely). False if already running. */
export function cancel(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'scheduled') return false;
  remove(jobId);
  return true;
}

/** Remove a job from the store, clearing any pending timer. */
export function remove(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  if (job._timer) clearTimeout(job._timer);
  jobs.delete(jobId);
  if (removeHandler) {
    try {
      removeHandler(job);
    } catch (err) {
      console.error(`[Scheduler] removeHandler error: ${err.message}`);
    }
  }
  return true;
}

/** Look up a single job (live record, not a copy). */
export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Active jobs only (scheduled / starting / running), newest first. Finished
 * jobs are pruned as a side effect: a running job whose bot has reached a
 * terminal state is deleted so the store only ever holds live work.
 */
export function listJobs() {
  for (const job of [...jobs.values()]) {
    const botDone =
      job.botId && botStatusResolver && TERMINAL_BOT_STATUSES.has(botStatusResolver(job.botId));
    if (botDone || !ACTIVE_JOB_STATUSES.has(job.status)) {
      remove(job.id);
    }
  }
  return Array.from(jobs.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(toPublic);
}

function toPublic(job) {
  const { _timer, ...rest } = job;
  return rest;
}
