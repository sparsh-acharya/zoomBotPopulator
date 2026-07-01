// scripts/stop.js
// Cross-platform "kill whatever is listening on PORT" for `npm stop`.
// Works on Windows (netstat + taskkill) and Linux/macOS (lsof).

import { execSync } from 'node:child_process';

const PORT = process.env.PORT || 3000;
const isWindows = process.platform === 'win32';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function pidsOnPort() {
  const pids = new Set();
  try {
    if (isWindows) {
      // netstat rows: Proto  Local  Foreign  State  PID  — take LISTENING rows.
      const out = run(`netstat -ano -p tcp`);
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(`:${PORT} `) || !/LISTENING/i.test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
    } else {
      // -t = terse (PIDs only), -sTCP:LISTEN = listening sockets only.
      const out = run(`lsof -t -i:${PORT} -sTCP:LISTEN`);
      for (const pid of out.split(/\s+/)) if (pid) pids.add(pid);
    }
  } catch {
    // No matching process → the command exits non-zero; treat as "nothing found".
  }
  return [...pids];
}

const pids = pidsOnPort();
if (pids.length === 0) {
  console.log(`Nothing is listening on port ${PORT} — already stopped.`);
  process.exit(0);
}

for (const pid of pids) {
  try {
    run(isWindows ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`);
    console.log(`Stopped server on port ${PORT} (pid ${pid}).`);
  } catch (err) {
    console.error(`Failed to stop pid ${pid}: ${err.message}`);
    console.error(isWindows ? 'Try an elevated (Administrator) terminal.' : 'Try: sudo npm stop');
    process.exitCode = 1;
  }
}
