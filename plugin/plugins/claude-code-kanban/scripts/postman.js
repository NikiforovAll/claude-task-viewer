#!/usr/bin/env node
// Kanban -> session doorbell.
//
// Claude Code delivers every line a monitor prints to the owning session as a task
// notification, so this process is the only way board activity can reach a session that
// is sitting idle. It long-polls the kanban server for events addressed to this session
// and prints them one per line.
//
// Pairing is free: CLAUDE_CODE_SESSION_ID is inherited from the session that spawned us,
// so the id we poll with is the same id the hooks report. No cwd or pid guessing.
//
// The lines we print carry board text (the card subject and description), which the
// session is told to read as the user's own brief. That is only safe because we are armed
// by an explicit `kanban-follow` invocation: the user asked to follow the board before anything the
// board says can reach the model.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID;
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SERVER_INFO = path.join(CLAUDE_DIR, '.cck', 'server.json');
// The server caps its own wait at 120s. Sitting at the ceiling halves every recurring
// cost -- handshake, route walk, timer, empty response -- and costs no event latency,
// because an enqueue wakes the poll immediately.
const WAIT_SEC = 120;
const RETRY_MS = 15000;

if (!SESSION_ID) process.exit(0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Re-read every cycle rather than caching: it is how we follow the board across a
// restart onto a different port. A file left behind by a crashed server names a port
// something else may now hold, so trust it only while its pid is alive.
function serverUrl() {
  const { port, pid } = JSON.parse(fs.readFileSync(SERVER_INFO, 'utf8'));
  if (pid) process.kill(pid, 0);
  return `http://127.0.0.1:${port}`;
}

// Once per process, not once per poll: the grant means "follow the board from here on", so
// the first attach throws away whatever queued up before it. A later reconnect must not
// discard again -- by then the queue holds events the user is owed.
let firstAttach = true;

async function poll(base) {
  const first = firstAttach ? '&first=1' : '';
  const url = `${base}/api/sessions/${encodeURIComponent(SESSION_ID)}/events?wait=${WAIT_SEC}${first}`;
  const res = await fetch(url, { signal: AbortSignal.timeout((WAIT_SEC + 15) * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  firstAttach = false;
  const { events } = await res.json();
  return Array.isArray(events) ? events : [];
}

(async () => {
  for (;;) {
    try {
      for (const line of await poll(serverUrl())) console.log(line);
    } catch (_) {
      // No board yet, or it went away. It may come back later in the session, so keep
      // waiting quietly -- a missing server is the normal case, not an error.
      await sleep(RETRY_MS);
    }
  }
})();
