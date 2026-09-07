#!/usr/bin/env node

// #region SETUP
const express = require('express');
const path = require('node:path');
const fs = require('node:fs').promises;
const { existsSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync, mkdirSync, renameSync, openSync, readSync, closeSync } = require('node:fs');
const _readline = require('node:readline');
const chokidar = require('chokidar');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { assertOpenTarget, openInEditor, whichSync, exeBehindShim } = require('./lib/open-editor');
const { createNetGuard } = require('./lib/net-guard');
const { isContained } = require('./lib/contain');
const { fileUrlToPath } = require('./lib/file-url');

const {
  readRecentMessages: _readRecentMessagesUncached,
  readMessagesPage: _readMessagesPageUncached,
  readSessionInfoFromJsonl,
  buildSessionDigest,
  readCompactSummaries,
  extractPromptFromTranscript,
  extractModelFromTranscript,
  extractStructuredResultFromTranscript,
  extractTranscriptStats,
  readFullToolResult,
  readUserImage,
  readToolResultImage,
  readCachedImage,
  updateLoopInfo,
  buildLoopInfoFromState
} = require('./lib/parsers');
const { inlineHtmlAssets } = require('./lib/inline-assets');
const { buildDecision, decisionFileName, isDecisionFile, waitSecondsFrom, isLapsed } = require('./lib/approvals');
const { getClaudeDir, getArgValue } = require('./lib/claude-dir');

if (process.argv.includes("--install") || process.argv.includes("--uninstall")) {
  const { runInstall, runUninstall } = require("./install");
  const pluginOnly = process.argv.includes("--plugin-only");
  (process.argv.includes("--install") ? runInstall({ pluginOnly }) : runUninstall())
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
  return;
}
if (require("./cli").runCli(process.argv)) return;


const app = express();
const PORT = process.env.PORT || 3541;

// Mounted before express.json() so a rejected request never buffers a body, and
// before the /api catch-all so no route escapes the check.
const net = createNetGuard({ appName: 'Claude Task Kanban' });
app.use(net.hostGuard);
app.use(net.frameGuard);
app.use(net.originGuard);

function getArgUrl(argName, envName) {
  return getArgValue(argName) || process.env[envName] || null;
}

const MARKETPLACE_URL = getArgUrl('marketplace-url', 'MARKETPLACE_URL');
const COST_URL = getArgUrl('cost-url', 'COST_URL');
const MEMORY_URL = getArgUrl('memory-url', 'MEMORY_URL');
const CLAUDE_DIR = getClaudeDir();
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const CCK_DIR = path.join(CLAUDE_DIR, '.cck');
const AGENT_ACTIVITY_DIR = path.join(CCK_DIR, 'agent-activity');
const CONTEXT_STATUS_DIR = path.join(CCK_DIR, 'context-status');
const PINS_FILE = path.join(CCK_DIR, 'pins.json');
const SERVER_INFO_FILE = path.join(CCK_DIR, 'server.json');
// Harness-owned scratchpad root; the per-session dir under it is created lazily.
const SCRATCHPAD_ROOT = path.join(os.tmpdir(), 'claude');

// #endregion

// #region SERVER_STATE
// Server-side pin mirror (UI authoritative, server stores latest pushed state for CLI queries).
function readPins() {
  try {
    const obj = JSON.parse(readFileSync(PINS_FILE, 'utf8'));
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (_) {}
  return {};
}

function writeJsonAtomic(file, obj) {
  try {
    mkdirSync(CCK_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    console.error(`Failed to write ${path.basename(file)}:`, e.message);
  }
}

function writePins(pins) {
  writeJsonAtomic(PINS_FILE, pins);
}

// Port discovery for out-of-process helpers (the postman monitor). The pid rides along
// so a reader can tell a live server from a file left behind by a crashed one.
function writeServerInfo(port) {
  writeJsonAtomic(SERVER_INFO_FILE, { port, pid: process.pid });
}

// #endregion

// #region TIMINGS
const PERMISSION_TTL_MS = 30 * 60 * 1000;
const AGENT_TTL_MS = 60 * 60 * 1000;
const AGENT_STALE_MS = 30 * 60 * 1000; // safety net for crashed sessions
const SESSION_STALE_MS = 5 * 60 * 1000;
// Keep an idle session in the active list this long after its last log write, so it
// doesn't vanish the instant a turn ends. Ungated by registry-idle — visibility only,
// never the "active" status (which stays accurate via hasRecentLog).
const SESSION_GRACE_MS = 2 * 60 * 1000;
const WAITING_RESOLVE_GRACE_MS = 15 * 1000;
const CTX_CLEANUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLEANUP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// #endregion

// #region AGENT_ACTIVITY

function readAgentJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const merged = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { Object.assign(merged, JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return merged;
}

// Agent-activity record files in a session dir, excluding the `_`-prefixed sidecars
// (_waiting.json, _name-*). Returns [] if the dir is missing/unreadable.
function listAgentFiles(agentDir) {
  try {
    return readdirSync(agentDir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('_'));
  } catch (_) {
    return [];
  }
}

function persistAgent(dir, agent) {
  const file = path.join(dir, `${agent.agentId}.jsonl`);
  fs.appendFile(file, `${JSON.stringify({ ...agent, event: 'server-update' })}\n`, 'utf8').catch(() => {});
}

// Lapse math lives in lib/approvals (kept in sync with the gate's own parse);
// this only reads the config, cached so the polled session list doesn't re-read
// it per hit (marker stays visible for the badge until TTL).
const APPROVALS_CONFIG_FILE = path.join(CCK_DIR, 'approvals.json');
let approvalsWaitCache = { ts: 0, ms: 30 * 1000 };
function approvalsWaitMs() {
  if (Date.now() - approvalsWaitCache.ts < 10 * 1000) return approvalsWaitCache.ms;
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(APPROVALS_CONFIG_FILE, 'utf8'));
  } catch { /* missing config — gate default */ }
  approvalsWaitCache = { ts: Date.now(), ms: waitSecondsFrom(cfg) * 1000 };
  return approvalsWaitCache.ms;
}

function isWaitingLapsed(data) {
  return isLapsed(data.timestamp, approvalsWaitMs());
}

function checkWaitingForUser(agentDir, logMtime) {
  try {
    const data = JSON.parse(readFileSync(path.join(agentDir, '_waiting.json'), 'utf8'));
    if (data.status === 'waiting' && data.timestamp) {
      const waitTime = new Date(data.timestamp).getTime();
      const age = Date.now() - waitTime;
      if (age >= PERMISSION_TTL_MS) return null;
      // After grace period, check if session resumed activity (user already responded)
      if (logMtime && age >= WAITING_RESOLVE_GRACE_MS && logMtime > waitTime + WAITING_RESOLVE_GRACE_MS) return null;
      if (isWaitingLapsed(data)) return { ...data, lapsed: true };
      return data;
    }
  } catch { /* skip — missing or invalid */ }
  return null;
}

function agentDisplayName(agent) {
  return agent.type || agent.name;
}

function isGhostAgent(agent) {
  if (agent.startedAt !== agent.updatedAt || agent.lastMessage) return false;
  return (Date.now() - new Date(agent.startedAt).getTime()) >= AGENT_STALE_MS;
}

function getContextStatus(sessionId, meta) {
  return contextStatusCache.get(sessionId) || (meta?.teamLeaderId ? contextStatusCache.get(meta.teamLeaderId) : null) || null;
}

function isAgentFresh(agent) {
  if (isGhostAgent(agent)) return false;
  const ts = agent.updatedAt || agent.startedAt;
  if (!ts) return true;
  return (Date.now() - new Date(ts).getTime()) < AGENT_TTL_MS;
}

function isAgentLive(agent) {
  return agent.status === 'active' || agent.status === 'idle';
}

// Claude Code records gitBranch from the launch-time repo and never updates it
// when cwd shifts (Bash `cd`, submodule, sibling repo). Resolve on-demand from
// the live cwd instead. Cached per-cwd with a short TTL so a list refresh
// across N sessions sharing one cwd spawns git at most once per TTL window.
const gitBranchCache = new Map();
const GIT_BRANCH_TTL_MS = 30000;
const GIT_BRANCH_CACHE_MAX = 500;
function getGitBranch(cwd) {
  if (!cwd) return null;
  const now = Date.now();
  const cached = gitBranchCache.get(cwd);
  if (cached && now - cached.ts < GIT_BRANCH_TTL_MS) return cached.branch;
  let branch = null;
  try {
    // cwd rather than `-C <cwd>`: a path beginning with a dash would otherwise be
    // read by git as an option.
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', timeout: 500, windowsHide: true
    });
    if (r.status === 0) {
      const out = (r.stdout || '').trim();
      if (out && out !== 'HEAD') branch = out;
    }
  } catch (_) {}
  gitBranchCache.set(cwd, { branch, ts: now });
  if (gitBranchCache.size > GIT_BRANCH_CACHE_MAX) {
    const firstKey = gitBranchCache.keys().next().value;
    gitBranchCache.delete(firstKey);
  }
  return branch;
}

// Only spawn git when cwd has diverged from the launch project — that's the
// only case the JSONL value is wrong. Saves N spawns on a typical list build.
function resolveSessionGitBranch(meta) {
  if (meta.cwd && meta.project && meta.cwd !== meta.project) {
    return getGitBranch(meta.cwd) || meta.gitBranch || null;
  }
  return meta.gitBranch || null;
}

function getSessionLogStat(meta) {
  if (!meta.jsonlPath) return { mtime: null, hasMessages: false };
  try {
    const st = statSync(meta.jsonlPath);
    return { mtime: st.mtimeMs, hasMessages: st.size > 1000 };
  } catch { return { mtime: null, hasMessages: false }; }
}

function checkAgentStatus(agentDir, stale, logMtime, isTeam) {
  const result = { hasActive: false, hasRunning: false, waitingForUser: null };
  if (!existsSync(agentDir)) return result;
  result.waitingForUser = checkWaitingForUser(agentDir, logMtime);
  if (result.waitingForUser) result.hasActive = true;
  if (stale && !isTeam) return result;
  try {
    for (const file of readdirSync(agentDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'))) {
      try {
        const agent = readAgentJsonl(path.join(agentDir, file));
        // Idle agents never mark a session active (an idle teammate lingers and
        // would pin the filter). Teams skip freshness so long-running teammates stay visible.
        if (agent.status === 'active' && (isTeam || isAgentFresh(agent))) {
          result.hasActive = true;
          result.hasRunning = true;
        }
        if (result.hasRunning) break;
      } catch { /* skip invalid */ }
    }
  } catch { /* ignore */ }
  return result;
}

// #endregion

// #region TEAMS
// isContained canonicalises both sides with realpath, which costs ~100x a plain
// path.join. This is called once per session on the /api/sessions hot path, and
// the verdict for a given name cannot change while TEAMS_DIR is fixed — so the
// resolved path (or the null rejection) is memoized.
const teamPathCache = new Map();
const TEAM_PATH_CACHE_MAX = 1000;

function teamConfigPath(teamName) {
  if (typeof teamName !== 'string' || !teamName) return null;
  if (teamPathCache.has(teamName)) return teamPathCache.get(teamName);
  const candidate = path.join(TEAMS_DIR, teamName, 'config.json');
  // TEAMS_DIR follows --dir / CLAUDE_CONFIG_DIR, so containment is checked against
  // the module-level constant rather than a hardcoded ~/.claude/teams.
  const configPath = isContained(candidate, TEAMS_DIR) ? candidate : null;
  if (teamPathCache.size >= TEAM_PATH_CACHE_MAX) teamPathCache.clear();
  teamPathCache.set(teamName, configPath);
  return configPath;
}

function isTeamSession(sessionId) {
  const configPath = teamConfigPath(sessionId);
  return !!configPath && existsSync(configPath);
}

const teamConfigCache = new Map();
const TEAM_CACHE_TTL = 5000;

function loadTeamConfig(teamName) {
  const cached = teamConfigCache.get(teamName);
  if (cached && Date.now() - cached.ts < TEAM_CACHE_TTL) return cached.data;
  try {
    const configPath = teamConfigPath(teamName);
    if (!configPath || !existsSync(configPath)) return null;
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    teamConfigCache.set(teamName, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

function resolveSessionId(sessionId) {
  const teamConfig = loadTeamConfig(sessionId);
  return (teamConfig?.leadSessionId) ? teamConfig.leadSessionId : sessionId;
}

// Recent Claude Code releases auto-create a single-member "self-team" for every
// session: a teams/session-<id>/config.json whose only member is the "team-lead"
// (the session itself). These are not real multi-agent teams — surfacing them
// makes every solo session render a team badge, member panel, and (via the empty
// team-named task dir) a shared-task-list link. Treat them as plain sessions.
// As soon as a real teammate joins (members.length > 1) it becomes a true team again.
function isAutoSelfTeam(cfg) {
  if (!cfg || !Array.isArray(cfg.members)) return false;
  const namedSession = typeof cfg.name === 'string' && cfg.name.startsWith('session-');
  const soleLead = cfg.members.length === 0
    || (cfg.members.length === 1 && cfg.members[0]?.agentType === 'team-lead');
  return namedSession && soleLead;
}

// Claude Code 2.1.x stores a session's tasks in its self-team list (tasks/session-<id>/).
// Usually `cfg.leadSessionId` is that session and already has a card. But a resumed /
// continued session keeps writing to the original team's list while running under a new
// session id, so `leadSessionId` points at the original (often a ghost with no card) and
// the tasks can't be matched to the live session by id. The on-disk bridge is the
// live-session registry (~/.claude/sessions/<pid>.json): the team's `createdAt` ≈ the
// owning session's `startedAt` (both written at boot) and they share a cwd. Match on that.
const SELF_TEAM_BOOT_WINDOW_MS = 60 * 1000;
let liveSessionsCache = null;
let lastLiveSessionsScan = 0;
const LIVE_SESSIONS_TTL = 5000;

function loadLiveSessions() {
  const now = Date.now();
  if (liveSessionsCache && now - lastLiveSessionsScan < LIVE_SESSIONS_TTL) return liveSessionsCache;
  const sessions = [];
  if (existsSync(SESSIONS_DIR)) {
    try {
      for (const file of readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))) {
        try {
          const s = JSON.parse(readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
          if (s?.sessionId && s.kind === 'interactive') {
            sessions.push({ sessionId: s.sessionId, cwd: s.cwd || null, startedAt: s.startedAt || 0, status: s.status || null });
          }
        } catch (_) { /* skip invalid */ }
      }
    } catch (_) { /* ignore */ }
  }
  liveSessionsCache = sessions;
  lastLiveSessionsScan = now;
  return sessions;
}

// An open-but-idle interactive session keeps touching its JSONL (metadata-line
// rewrites), so mtime alone reads as activity for as long as the terminal stays
// open. Claude Code's live-session registry knows the real state — trust its
// 'idle' over the mtime. No registry entry (or any other status) falls back to
// the mtime rule.
function isRegistryIdle(sessionId) {
  const live = loadLiveSessions().find(s => s.sessionId === sessionId);
  return live?.status === 'idle';
}

function hasRecentLogActivity(sessionId, logAge) {
  return logAge <= SESSION_STALE_MS && !isRegistryIdle(sessionId);
}

// Visibility-only recency: hasRecentLogActivity widened by the post-turn grace
// window (ungated by registry-idle). Drives whether a session appears in the
// active list — never the "active" status badges, which stay on hasRecentLog.
function hasVisibleLogActivity(sessionId, logAge) {
  return logAge <= SESSION_GRACE_MS || hasRecentLogActivity(sessionId, logAge);
}

// Given a self-team config, return the live interactive session id that owns it
// (same cwd, startedAt within the boot window of the team's createdAt), or null.
function resolveSelfTeamOwner(cfg) {
  if (!cfg?.createdAt) return null;
  const teamCwd = cfg.members?.[0]?.cwd;
  if (!teamCwd) return null;
  let best = null, bestDelta = Infinity;
  for (const s of loadLiveSessions()) {
    if (s.cwd !== teamCwd) continue;
    const delta = Math.abs(s.startedAt - cfg.createdAt);
    if (delta <= SELF_TEAM_BOOT_WINDOW_MS && delta < bestDelta) {
      best = s.sessionId;
      bestDelta = delta;
    }
  }
  return best;
}

// Attach a team-named task dir's counts to a session card, preferring the most recently written
// dir (see taskDirBeats — "latest wins"). A resumed session owns several team dirs: a stale
// prior-boot dir plus the current run's dir; the older "most tasks wins" rule attached the stale
// dir when it had more tasks than the live one. The incumbent's mtime comes from the path-cached
// counts (every card.tasksDir was already passed through getTaskCounts by the caller, so this is a
// cache hit, not disk I/O). Caller passes the already-computed candidate counts.
function attachTeamTasks(card, teamTaskDir, teamName, counts) {
  let curMtime = -1, curCount = -1;
  if (card.tasksDir) {
    const cur = getTaskCounts(card.tasksDir);
    curMtime = taskDirMtime(cur);
    curCount = cur.taskCount;
  }
  if (taskDirBeats(taskDirMtime(counts), counts.taskCount, curMtime, curCount)) {
    Object.assign(card, {
      taskCount: counts.taskCount,
      completed: counts.completed,
      inProgress: counts.inProgress,
      pending: counts.pending,
      tasksDir: teamTaskDir,
      sharedTaskList: teamName,
    });
  }
}

// #endregion

// #region SHARED_STATE
// SSE clients for live updates
const clients = new Set();

// Cache for session metadata (refreshed periodically)
let sessionMetadataCache = {};
let lastMetadataRefresh = 0;
const METADATA_CACHE_TTL = 10000; // 10 seconds
// Watcher-driven invalidation. `change` events (append to existing jsonl) only
// dirty the one path so we can do a targeted refresh; `add` / `unlink` events
// are structural and force a full rescan.
const dirtyMetadataPaths = new Set();
let metadataNeedsFullScan = true;

// #endregion

// #region REQUEST_GUARDS
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id);
}

app.param('sessionId', (_req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid session ID' });
  next();
});
app.param('taskId', (_req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid task ID' });
  next();
});
// Team names are directory names under TEAMS_DIR, so /api/teams/:name was a
// straight traversal before this.
app.param('name', (_req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid team name' });
  next();
});

// Parse JSON bodies
app.use(express.json());
// #endregion

// #region STATIC

app.get('/hub-config', (_req, res) => {
  res.json({ enabled: !!process.env.CLAUDE_HUB, url: process.env.HUB_URL || null });
});

// Serve static files
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));
// #endregion

// #region SESSION_LIST

const messageCache = new Map();
const MESSAGE_CACHE_TTL = 5000;
const MAX_CACHE_ENTRIES = 200;
const compactSummaryCache = new Map();
const taskCountsCache = new Map();
const contextStatusCache = new Map();
const TASK_MAPS_DIR = path.join(AGENT_ACTIVITY_DIR, '_task-maps');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(s) { return UUID_RE.test(s); }

function evictStaleCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

let sessionToTaskListCache = null;
let lastTaskMapScan = 0;
const TASK_MAP_SCAN_TTL = 5000;

function loadAllTaskMaps() {
  const now = Date.now();
  if (sessionToTaskListCache && now - lastTaskMapScan < TASK_MAP_SCAN_TTL) return sessionToTaskListCache;

  const sessionToList = {};
  const listToSessions = {};
  if (!existsSync(TASK_MAPS_DIR)) {
    sessionToTaskListCache = { sessionToList, listToSessions };
    lastTaskMapScan = now;
    return sessionToTaskListCache;
  }
  try {
    for (const file of readdirSync(TASK_MAPS_DIR).filter(f => f.endsWith('.json'))) {
      const taskListName = file.replace(/\.json$/, '');
      const mapPath = path.join(TASK_MAPS_DIR, file);
      try {
        const map = JSON.parse(readFileSync(mapPath, 'utf8'));
        listToSessions[taskListName] = map;
        for (const sessionId of Object.keys(map)) {
          sessionToList[sessionId] = taskListName;
        }
      } catch { /* skip invalid */ }
    }
  } catch { /* ignore */ }
  sessionToTaskListCache = { sessionToList, listToSessions };
  lastTaskMapScan = now;
  return sessionToTaskListCache;
}

function getCustomTaskDir(sessionId) {
  const { sessionToList } = loadAllTaskMaps();
  const taskListName = sessionToList[sessionId];
  if (taskListName) {
    const dir = path.join(TASKS_DIR, taskListName);
    if (existsSync(dir)) return dir;
  }
  // Check team-named task directory (teams store tasks under ~/.claude/tasks/<teamName>/).
  // Match either the recorded leadSessionId, or — for 2.1.x self-teams whose lead is a
  // team-lead agent id — the live interactive session that owns the team (see resolveSelfTeamOwner).
  // A live session can own several team dirs at once: a stale dir from a prior boot of the same
  // session id, plus the current run's dir (a resume creates a fresh self-team). Pick the most
  // recently written dir ("latest wins") — the old "most tasks wins" rule picked the stale dir
  // whenever a completed prior run had accumulated more tasks than the live one. taskCount breaks
  // ties; empty dirs (no task mtime) lose, so a real dir still beats an empty self-team.
  if (existsSync(TEAMS_DIR)) {
    try {
      let bestDir = null, bestMtime = -1, bestCount = -1;
      for (const dir of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const cfg = loadTeamConfig(dir.name);
        if (!cfg) continue;
        const owns = cfg.leadSessionId === sessionId
          || (isAutoSelfTeam(cfg) && resolveSelfTeamOwner(cfg) === sessionId);
        if (!owns) continue;
        const teamTaskDir = path.join(TASKS_DIR, dir.name);
        if (!existsSync(teamTaskDir)) continue;
        const counts = getTaskCounts(teamTaskDir);
        const mtime = taskDirMtime(counts);
        if (taskDirBeats(mtime, counts.taskCount, bestMtime, bestCount)) {
          bestMtime = mtime;
          bestCount = counts.taskCount;
          bestDir = teamTaskDir;
        }
      }
      if (bestDir) return bestDir;
    } catch (_) {}
  }
  return null;
}

// Where a session's task files live. The custom-list and team lookups can both miss, and
// the fallback is the plain per-session dir -- every route that touches a task file needs
// that same resolution, so it lives in one place.
function taskDirFor(sessionId) {
  return getCustomTaskDir(sessionId) || path.join(TASKS_DIR, sessionId);
}

function getTaskCounts(sessionPath) {
  const cached = taskCountsCache.get(sessionPath);
  if (cached) return cached;

  const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
  let completed = 0, inProgress = 0, pending = 0, newestTaskMtime = null;
  // Directory mtime bumps when task files are added/removed, so it stays fresh even for an
  // emptied dir (task list closed) that has no files left to date. Task-file mtime alone would
  // report 0 for such a dir and lose "latest wins" to a stale prior-boot dir.
  let dirMtime = 0;
  try { dirMtime = statSync(sessionPath).mtimeMs; } catch (_) {}

  for (const file of taskFiles) {
    try {
      const taskPath = path.join(sessionPath, file);
      const task = JSON.parse(readFileSync(taskPath, 'utf8'));
      if (task.metadata?._internal) continue;
      if (task.status === 'completed') completed++;
      else if (task.status === 'in_progress') inProgress++;
      else pending++;
      const taskStat = statSync(taskPath);
      if (!newestTaskMtime || taskStat.mtime > newestTaskMtime) {
        newestTaskMtime = taskStat.mtime;
      }
    } catch { /* skip invalid */ }
  }

  const taskCount = completed + inProgress + pending;
  const result = { taskCount, completed, inProgress, pending, newestTaskMtime, dirMtime };
  taskCountsCache.set(sessionPath, result);
  return result;
}

// Last-write recency of a getTaskCounts() result, in ms: the newer of the directory mtime (bumps
// on add/remove, so it survives an emptied dir) and the newest task-file mtime (bumps on in-place
// status edits, which don't touch the dir). An emptied current dir thus still ranks by when it was
// cleared, letting it win "latest wins" over a stale prior-boot dir instead of reporting 0.
function taskDirMtime(counts) {
  const fileMtime = counts.newestTaskMtime ? counts.newestTaskMtime.getTime() : 0;
  return Math.max(counts.dirMtime || 0, fileMtime);
}

// "Latest wins" ranking for two owned task dirs of the same session: more recently written wins,
// taskCount breaks ties. Callers seed the incumbent with mtime/count -1 so the first candidate
// always wins.
function taskDirBeats(candMtime, candCount, curMtime, curCount) {
  return candMtime > curMtime || (candMtime === curMtime && candCount > curCount);
}

function cachedByMtime(cache, cacheKey, filePath, loadFn, fallback) {
  try {
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < MESSAGE_CACHE_TTL) return cached.data;
    const st = statSync(filePath);
    if (cached && cached.mtime === st.mtimeMs) {
      cached.ts = Date.now();
      return cached.data;
    }
    const data = loadFn();
    cache.set(cacheKey, { data, mtime: st.mtimeMs, ts: Date.now() });
    evictStaleCache(cache);
    return data;
  } catch (_) { return fallback; }
}

const sessionDigestCache = new Map();
function getSessionDigest(jsonlPath) {
  return cachedByMtime(sessionDigestCache, jsonlPath, jsonlPath, () => buildSessionDigest(jsonlPath), { progressMap: {}, terminated: new Map() });
}

function getProgressMap(jsonlPath) {
  return getSessionDigest(jsonlPath).progressMap;
}

function getTerminatedTeammates(jsonlPath) {
  return getSessionDigest(jsonlPath).terminated;
}

function readRecentMessages(jsonlPath, limit = 10) {
  return cachedByMtime(messageCache, `${jsonlPath}:${limit}`, jsonlPath, () => _readRecentMessagesUncached(jsonlPath, limit), []);
}

/**
 * Scan all project directories to find session JSONL files and extract slugs
 */
// Returns false when sessionId is unknown — caller must promote to full scan.
function refreshSessionMetadataPath(jsonlPath) {
  const sessionId = path.basename(jsonlPath, '.jsonl');
  if (!isSafeId(sessionId)) return false;
  const existing = sessionMetadataCache[sessionId];
  if (!existing) return false;
  let info;
  try {
    info = readSessionInfoFromJsonl(jsonlPath);
  } catch (_) {
    return false;
  }
  // Shadow JSONLs (continued from a worktree) hold only custom-title / agent-
  // name records — no projectPath. Don't let a shadow clobber the real entry.
  const shadow = existing.project && !info.projectPath;
  if (shadow) {
    if (!existing.slug && info.slug) existing.slug = info.slug;
    if (!existing.customTitle && info.customTitle) existing.customTitle = info.customTitle;
    return true;
  }
  if (info.slug) existing.slug = info.slug;
  if (info.cwd) existing.cwd = info.cwd;
  if (info.gitBranch) existing.gitBranch = info.gitBranch;
  if (info.customTitle) existing.customTitle = info.customTitle;
  // Direct assign (not guarded) so a /goal clear propagates as null.
  existing.goal = info.goal || null;
  if (info.logicalParentUuid) existing.logicalParentUuid = info.logicalParentUuid;
  if (info.compactBoundaryUuid) existing.compactBoundaryUuid = info.compactBoundaryUuid;
  return true;
}

function loadSessionMetadata() {
  const now = Date.now();

  if (!metadataNeedsFullScan && now - lastMetadataRefresh < METADATA_CACHE_TTL) {
    if (dirtyMetadataPaths.size > 0) {
      for (const p of dirtyMetadataPaths) {
        if (!refreshSessionMetadataPath(p)) {
          // Unknown sessionId — structural change snuck in. Promote to full.
          metadataNeedsFullScan = true;
          break;
        }
      }
      dirtyMetadataPaths.clear();
      if (!metadataNeedsFullScan) return sessionMetadataCache;
    } else {
      return sessionMetadataCache;
    }
  }

  const metadata = {};

  try {
    if (!existsSync(PROJECTS_DIR)) {
      return metadata;
    }

    const projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const projectDir of projectDirs) {
      const projectPath = path.join(PROJECTS_DIR, projectDir.name);

      // Find all .jsonl files (session logs)
      const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      const sessionIds = [];

      // Read sessions-index.json first for canonical projectPath
      let indexProjectPath = null;
      const indexPath = path.join(projectPath, 'sessions-index.json');
      let indexEntries = [];
      if (existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(readFileSync(indexPath, 'utf8'));
          indexEntries = indexData.entries || [];
          for (const entry of indexEntries) {
            if (entry.projectPath) { indexProjectPath = entry.projectPath; break; }
          }
        } catch {}
      }

      // First pass: read all JSONL files
      let resolvedProjectPath = null;
      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const jsonlPath = path.join(projectPath, file);
        const sessionInfo = readSessionInfoFromJsonl(jsonlPath);

        if (sessionInfo.projectPath && !resolvedProjectPath) {
          resolvedProjectPath = sessionInfo.projectPath;
        }

        const candidateProject = indexProjectPath || sessionInfo.projectPath || null;
        const existing = metadata[sessionId];
        // Same sessionId can appear in multiple project dirs (e.g. "shadow"
        // JSONLs that only hold custom-title/agent-name records when a session
        // is continued from a worktree). Don't let a weaker entry (no cwd, no
        // project) overwrite a previously resolved one — just merge scalars.
        if (existing?.project && !candidateProject) {
          if (!existing.slug && sessionInfo.slug) existing.slug = sessionInfo.slug;
          if (!existing.customTitle && sessionInfo.customTitle) existing.customTitle = sessionInfo.customTitle;
          if (!existing.gitBranch && sessionInfo.gitBranch) existing.gitBranch = sessionInfo.gitBranch;
          sessionIds.push(sessionId);
          continue;
        }

        metadata[sessionId] = {
          slug: sessionInfo.slug,
          project: candidateProject,
          cwd: sessionInfo.cwd || null,
          gitBranch: sessionInfo.gitBranch || null,
          customTitle: sessionInfo.customTitle || null,
          goal: sessionInfo.goal || null,
          jsonlPath: jsonlPath,
          logicalParentUuid: sessionInfo.logicalParentUuid || null,
          compactBoundaryUuid: sessionInfo.compactBoundaryUuid || null
        };
        sessionIds.push(sessionId);
      }

      // Second pass: fill in missing project paths from siblings
      const canonicalProject = indexProjectPath || resolvedProjectPath;
      if (canonicalProject) {
        for (const sid of sessionIds) {
          if (!metadata[sid].project) {
            metadata[sid].project = canonicalProject;
          }
        }
      }

      // Apply index metadata (descriptions, custom titles, etc.)
      for (const entry of indexEntries) {
        if (entry.sessionId) {
          if (!metadata[entry.sessionId]) {
            metadata[entry.sessionId] = {
              slug: null,
              project: indexProjectPath || entry.projectPath || null,
              cwd: null,
              jsonlPath: null
            };
          }
          metadata[entry.sessionId].description = entry.description || null;
          if (entry.gitBranch) metadata[entry.sessionId].gitBranch = entry.gitBranch;
          if (entry.customTitle) metadata[entry.sessionId].customTitle = entry.customTitle;
          metadata[entry.sessionId].created = entry.created || null;
        }
      }
    }
  } catch (e) {
    console.error('Error loading session metadata:', e);
  }

  // For team sessions with no JSONL match, resolve from team config + parent session
  if (existsSync(TASKS_DIR)) {
    const taskDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of taskDirs) {
      if (!metadata[dir.name]) {
        const teamConfig = loadTeamConfig(dir.name);
        if (teamConfig) {
          const parentMeta = teamConfig.leadSessionId ? metadata[teamConfig.leadSessionId] : null;
          const leadMember = teamConfig.members?.find(m => m.agentId === teamConfig.leadAgentId) || teamConfig.members?.[0];
          const project = parentMeta?.project || leadMember?.cwd || teamConfig.working_dir || null;

          metadata[dir.name] = {
            slug: teamConfig.description || dir.name,
            project,
            jsonlPath: parentMeta?.jsonlPath || null,
            description: teamConfig.description || parentMeta?.description || null,
            gitBranch: parentMeta?.gitBranch || null,
            created: parentMeta?.created || null,
            isTeamLeader: false,
            teamLeaderId: teamConfig.leadSessionId || null
          };
        }
      }
    }
  }

  sessionMetadataCache = metadata;
  lastMetadataRefresh = now;
  metadataNeedsFullScan = false;
  dirtyMetadataPaths.clear();
  return metadata;
}

// Workflow (Workflow tool) scripts are persisted at
//   projects/<projEnc>/<sessionId>/workflows/scripts/<name>-<wf_id>.js
// The script's projEnc can differ from the session's own JSONL dir (the workflow
// may run from a different cwd), so we scan every project dir into a TTL-cached
// index rather than deriving the path from meta.jsonlPath. Isolated from the
// session-scan hot path: a single Map lookup per buildSessionObject call.
const WORKFLOW_INDEX_TTL_MS = 5000;
let workflowIndexCache = null; // Map<sessionId, Array<{id,name,path,mtimeMs}>>
let workflowIndexBuiltAt = 0;

function buildWorkflowIndex() {
  const index = new Map();
  if (!existsSync(PROJECTS_DIR)) return index;
  let projs;
  try { projs = readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return index; }
  for (const proj of projs) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(PROJECTS_DIR, proj.name);
    let sessDirs;
    try { sessDirs = readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
    for (const sess of sessDirs) {
      if (!sess.isDirectory() || !isUUID(sess.name)) continue;
      const scriptsDir = path.join(projPath, sess.name, 'workflows', 'scripts');
      let scripts;
      try { scripts = readdirSync(scriptsDir); } catch { continue; } // ENOENT for most — skip fast
      for (const f of scripts) {
        if (!f.endsWith('.js')) continue;
        const full = path.join(scriptsDir, f);
        let mtimeMs = 0;
        try { mtimeMs = statSync(full).mtimeMs; } catch {}
        const base = f.slice(0, -3);
        const m = base.match(/^(.*)-(wf_[a-z0-9-]+)$/i);
        const entry = { id: m ? m[2] : base, name: m ? m[1] : base, path: full, mtimeMs };
        if (!index.has(sess.name)) index.set(sess.name, []);
        index.get(sess.name).push(entry);
      }
    }
  }
  return index;
}

function getWorkflowIndex() {
  const now = Date.now();
  if (workflowIndexCache && now - workflowIndexBuiltAt < WORKFLOW_INDEX_TTL_MS) return workflowIndexCache;
  workflowIndexCache = buildWorkflowIndex();
  workflowIndexBuiltAt = now;
  return workflowIndexCache;
}

// Resolve a session's workflow scripts, newest first. Tries the raw id then the
// team-lead resolution (a team session's scripts live under the lead's dir).
function getWorkflowScripts(sessionId) {
  const idx = getWorkflowIndex();
  let list = idx.get(sessionId);
  if (!list?.length) {
    const alt = resolveSessionId(sessionId);
    if (alt && alt !== sessionId) list = idx.get(alt);
  }
  return list ? [...list].sort((a, b) => b.mtimeMs - a.mtimeMs) : [];
}

function getWorkflowInfoSummary(sessionId) {
  const list = getWorkflowIndex().get(sessionId);
  return { hasWorkflow: !!(list?.length), workflowCount: list ? list.length : 0 };
}

function getPlanInfo(slug) {
  if (!slug) return { hasPlan: false, planTitle: null, planPath: null };
  const planPath = path.join(PLANS_DIR, `${slug}.md`);
  if (!existsSync(planPath)) return { hasPlan: false, planTitle: null, planPath: null };
  try {
    const head = readFileSync(planPath, 'utf8').slice(0, 512);
    const match = head.match(/^#\s+(.+)$/m);
    return { hasPlan: true, planTitle: match ? match[1].trim() : null, planPath };
  } catch {
    return { hasPlan: true, planTitle: null, planPath };
  }
}

// Hide wakeups whose fire time is more than this far in the past — long /loop
// sessions otherwise produce dozens of stale entries that drown the badge.
const WAKEUP_FIRED_GRACE_MS = 5 * 60 * 1000;

function isWakeupActive(w, now = Date.now()) {
  if (!w?.timestamp || w.delaySeconds == null) return true;
  const fireMs = new Date(w.timestamp).getTime() + w.delaySeconds * 1000;
  return (now - fireMs) <= WAKEUP_FIRED_GRACE_MS;
}

function filterActiveLoopInfo(info) {
  const now = Date.now();
  return {
    wakeups: info.wakeups.filter(w => isWakeupActive(w, now)),
    crons: info.crons
  };
}

// Per-path incremental scan state. Populated lazily on first access and
// updated in place; the projectsWatcher event handler keeps entries warm so
// the request path does O(1) work in steady state.
const loopInfoStateByPath = new Map();

function refreshLoopInfoState(jsonlPath) {
  if (!jsonlPath) return null;
  const prev = loopInfoStateByPath.get(jsonlPath);
  const next = updateLoopInfo(jsonlPath, prev);
  if (next) loopInfoStateByPath.set(jsonlPath, next);
  return next;
}

function getLoopInfoSummary(meta) {
  const empty = { wakeupCount: 0, cronCount: 0, latest: null };
  if (!meta?.jsonlPath) return empty;
  try {
    const state = refreshLoopInfoState(meta.jsonlPath);
    const filtered = filterActiveLoopInfo(buildLoopInfoFromState(state));
    return {
      wakeupCount: filtered.wakeups.length,
      cronCount: filtered.crons.length,
      latest: filtered.wakeups[filtered.wakeups.length - 1] || filtered.crons[filtered.crons.length - 1] || null
    };
  } catch (_) { return empty; }
}

function getSessionDisplayName(_sessionId, meta) {
  if (meta?.customTitle) return meta.customTitle;
  if (meta?.slug) return meta.slug;
  return null;
}

// Derived by convention, not looked up: the harness creates the dir lazily, so a
// stat here would report "missing" for every session that has not written a temp
// file yet — and it would put IO on the session-list hot path. Pure string join.
function getScratchpadDir(id, meta) {
  if (!meta.jsonlPath) return null;
  return path.join(SCRATCHPAD_ROOT, path.basename(path.dirname(meta.jsonlPath)), id, 'scratchpad');
}

function buildSessionObject(id, meta, overrides = {}) {
  const logStat = overrides._logStat || getSessionLogStat(meta);
  const logMtime = logStat.mtime;
  const logAge = logMtime ? Date.now() - logMtime : Infinity;
  return {
    id,
    name: getSessionDisplayName(id, meta),
    slug: meta.slug || null,
    project: meta.project || null,
    cwd: meta.cwd || null,
    description: meta.description || null,
    gitBranch: resolveSessionGitBranch(meta),
    customTitle: meta.customTitle || null,
    goal: meta.goal || null,
    taskCount: 0,
    completed: 0,
    inProgress: 0,
    pending: 0,
    createdAt: meta.created || null,
    modifiedAt: overrides.modifiedAt || new Date(0).toISOString(),
    isTeam: false,
    memberCount: 0,
    hasMessages: logStat.hasMessages,
    hasActiveAgents: false,
    hasRunningAgents: false,
    hasWaitingForUser: false,
    hasRecentLog: hasRecentLogActivity(id, logAge),
    hasRecentActivity: hasVisibleLogActivity(id, logAge),
    jsonlPath: meta.jsonlPath || null,
    tasksDir: null,
    projectDir: meta.jsonlPath ? path.dirname(meta.jsonlPath) : null,
    scratchpadDir: getScratchpadDir(id, meta),
    contextStatus: getContextStatus(id, meta),
    ...getPlanInfo(meta.slug),
    ...getWorkflowInfoSummary(id),
    loopInfo: getLoopInfoSummary(meta),
    ...overrides,
    // Remove internal-only field
    _logStat: undefined,
  };
}

// #endregion

// #region SESSION_ROUTES
// API: List all sessions
app.get('/api/sessions', async (req, res) => {
  // Prevent browser caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    // Parse limit parameter (default: 20, "all" for unlimited)
    const limitParam = req.query.limit || '20';
    const limit = limitParam === 'all' ? null : parseInt(limitParam, 10);

    const pinnedParam = req.query.pinned;
    const pinnedIds = pinnedParam ? new Set(pinnedParam.split(',').filter(Boolean)) : new Set();
    const activeFilter = req.query.filter === 'active';

    const metadata = loadSessionMetadata();
    const sessionsMap = new Map();

    // First, add sessions that have tasks directories
    if (existsSync(TASKS_DIR)) {
      const entries = readdirSync(TASKS_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && isUUID(entry.name)) {
          const sessionPath = path.join(TASKS_DIR, entry.name);
          const stat = statSync(sessionPath);
          const { taskCount, completed, inProgress, pending, newestTaskMtime } = getTaskCounts(sessionPath);

          // Get metadata for this session
          const meta = metadata[entry.name] || {};

          const logStat = getSessionLogStat(meta);
          const logMtime = logStat.mtime;
          const logAge = logMtime ? Date.now() - logMtime : Infinity;
          const stale = logAge > AGENT_STALE_MS;

          const isTeam = isTeamSession(entry.name);
          const teamConfig = isTeam ? loadTeamConfig(entry.name) : null;
          const resolvedAgentDir = path.join(AGENT_ACTIVITY_DIR, teamConfig?.leadSessionId || entry.name);
          const agentStatus = checkAgentStatus(resolvedAgentDir, stale, logMtime, isTeam);

          // Cheap-probe: when filter=active, skip expensive enrichment for inactive non-pinned sessions.
          // Mirrors the post-filter predicate using only signals already computed above.
          if (activeFilter && !pinnedIds.has(entry.name)) {
            const cheaplyActive = logStat.hasMessages && (
              hasVisibleLogActivity(entry.name, logAge)
              || agentStatus.hasActive
              || !!agentStatus.waitingForUser
              || (pending > 0 || inProgress > 0)
            );
            if (!cheaplyActive) continue;
          }

          // Use newest of: task file mtime, JSONL mtime, directory mtime
          let modifiedAt = newestTaskMtime ? newestTaskMtime.toISOString() : stat.mtime.toISOString();
          if (logMtime) {
            const jsonlMtime = new Date(logMtime).toISOString();
            if (jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
          }

          const memberCount = teamConfig?.members?.length || 0;
          const planInfo = getPlanInfo(meta.slug);

          sessionsMap.set(entry.name, buildSessionObject(entry.name, meta, {
            _logStat: logStat,
            taskCount,
            completed,
            inProgress,
            pending,
            modifiedAt,
            isTeam,
            memberCount,
            hasActiveAgents: agentStatus.hasActive,
            hasRunningAgents: agentStatus.hasRunning,
            hasWaitingForUser: !!agentStatus.waitingForUser,
            tasksDir: sessionPath,
            ...planInfo
          }));
        }
      }

      // Process custom task lists (non-UUID directories mapped via _task-maps)
      const { listToSessions } = loadAllTaskMaps();
      for (const [taskListName, map] of Object.entries(listToSessions)) {
        const customTaskDir = path.join(TASKS_DIR, taskListName);
        if (!existsSync(customTaskDir)) continue;
        const counts = getTaskCounts(customTaskDir);

        for (const [sessionId, info] of Object.entries(map)) {
          const existing = sessionsMap.get(sessionId);
          if (existing) {
            Object.assign(existing, {
              taskCount: counts.taskCount,
              completed: counts.completed,
              inProgress: counts.inProgress,
              pending: counts.pending,
              tasksDir: customTaskDir,
              sharedTaskList: taskListName,
            });
          } else {
            const meta = { ...(metadata[sessionId] || {}) };
            if (!meta.project && info.project) meta.project = info.project;
            const logStat = getSessionLogStat(meta);
            const logMtime = logStat.mtime;
            const logAge = logMtime ? Date.now() - logMtime : Infinity;
            const stale = logAge > AGENT_STALE_MS;
            const agentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
            const agentStatus = checkAgentStatus(agentDir, stale, logMtime, false);
            let modifiedAt = info.updatedAt || new Date(0).toISOString();
            if (logMtime) {
              const jsonlMtime = new Date(logMtime).toISOString();
              if (jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
            }
            sessionsMap.set(sessionId, buildSessionObject(sessionId, meta, {
              _logStat: logStat,
              taskCount: counts.taskCount,
              completed: counts.completed,
              inProgress: counts.inProgress,
              pending: counts.pending,
              modifiedAt,
              hasActiveAgents: agentStatus.hasActive,
              hasRunningAgents: agentStatus.hasRunning,
              hasWaitingForUser: !!agentStatus.waitingForUser,
              tasksDir: customTaskDir,
              sharedTaskList: taskListName,
            }));
          }
        }
      }
    }

    // Add sessions from metadata that don't have task directories
    for (const [sessionId, meta] of Object.entries(metadata)) {
      if (!sessionsMap.has(sessionId)) {
        const logStat = getSessionLogStat(meta);
        const logMtime = logStat.mtime;
        const logAge = logMtime ? Date.now() - logMtime : Infinity;
        const stale = logAge > AGENT_STALE_MS;
        const metaIsTeam = isTeamSession(sessionId);
        const metaAgentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
        const metaAgentStatus = checkAgentStatus(metaAgentDir, stale, logMtime, metaIsTeam);

        // Cheap-probe: no tasks here (metadata-only), so active = recent log OR live agent.
        if (activeFilter && !pinnedIds.has(sessionId)) {
          const cheaplyActive = logStat.hasMessages && (
            hasVisibleLogActivity(sessionId, logAge) || metaAgentStatus.hasActive || !!metaAgentStatus.waitingForUser
          );
          if (!cheaplyActive) continue;
        }

        let modifiedAt = meta.created || null;
        if (logMtime) {
          const jsonlMtime = new Date(logMtime).toISOString();
          if (!modifiedAt || jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
        }
        sessionsMap.set(sessionId, buildSessionObject(sessionId, meta, {
          _logStat: logStat,
          modifiedAt: modifiedAt || new Date(0).toISOString(),
          hasActiveAgents: metaAgentStatus.hasActive,
          hasRunningAgents: metaAgentStatus.hasRunning,
          hasWaitingForUser: !!metaAgentStatus.waitingForUser,
        }));
      }
    }

    // Add sessions from agent-activity that have _waiting.json but no tasks/metadata
    if (existsSync(AGENT_ACTIVITY_DIR)) {
      try {
        for (const dir of readdirSync(AGENT_ACTIVITY_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory() || sessionsMap.has(dir.name)) continue;
          const agentDir = path.join(AGENT_ACTIVITY_DIR, dir.name);
          const meta = metadata[dir.name] || {};
          const logStat = getSessionLogStat(meta);
          const waiting = checkWaitingForUser(agentDir, logStat.mtime);
          if (!waiting) continue;
          sessionsMap.set(dir.name, buildSessionObject(dir.name, meta, {
            _logStat: logStat,
            modifiedAt: waiting.timestamp || new Date().toISOString(),
            hasActiveAgents: true,
            hasWaitingForUser: true,
          }));
        }
      } catch { /* ignore */ }
    }

    // Enrich leader sessions with team info and remove team-named duplicates
    const teamLeaderIds = new Set();
    if (existsSync(TEAMS_DIR)) {
      try {
        for (const dir of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const cfg = loadTeamConfig(dir.name);
          if (!cfg?.leadSessionId) continue;
          const leaderId = cfg.leadSessionId;
          // Remove the team-named duplicate before bailing on self-teams. Otherwise an
          // auto-created session-<uuid> self-team dir leaves a duplicate session card whose
          // id (session-<uuid>) resolves no messages, so switching to it shows a stale log.
          if (sessionsMap.has(dir.name) && dir.name !== leaderId) sessionsMap.delete(dir.name);
          if (isAutoSelfTeam(cfg)) {
            // Self-teams are normally noise with an empty team-named task dir. But 2.1.x stores a
            // session's tasks in the self-team list (tasks/session-<id>/), so when it's non-empty
            // the tasks would be silently orphaned. Recover them: attach to the owning card — the
            // recorded leadSessionId when it has one, else the live session continuing it (resolved
            // from the session registry), else a freshly-built fallback lead card.
            const teamTaskDir = path.join(TASKS_DIR, dir.name);
            if (!existsSync(teamTaskDir)) continue;
            const counts = getTaskCounts(teamTaskDir);

            const ownerCard = sessionsMap.get(leaderId) || sessionsMap.get(resolveSelfTeamOwner(cfg));
            if (ownerCard) {
              // Attach even when empty: a resumed session's freshly-emptied current dir (task list
              // closed) must be allowed to win "latest wins" and suppress its stale prior-boot dir,
              // otherwise the card resurfaces the previous tasks. attachTeamTasks ranks by recency.
              attachTeamTasks(ownerCard, teamTaskDir, dir.name, counts);
            } else {
              // No owner card to attach to — don't fabricate one for an empty stale self-team
              // (that is the original noise case the skip suppressed).
              if (counts.taskCount === 0) continue;
              const meta = metadata[leaderId] || {};
              const logStat = getSessionLogStat(meta);
              const logMtime = logStat.mtime;
              const logAge = logMtime ? Date.now() - logMtime : Infinity;
              const agentDir = path.join(AGENT_ACTIVITY_DIR, leaderId);
              const agentStatus = checkAgentStatus(agentDir, logAge > AGENT_STALE_MS, logMtime, false);
              const taskMtime = taskDirMtime(counts);
              const card = buildSessionObject(leaderId, meta, {
                _logStat: logStat,
                name: getSessionDisplayName(leaderId, meta) || cfg.name || dir.name,
                modifiedAt: new Date(Math.max(taskMtime, logMtime || 0)).toISOString(),
                hasActiveAgents: agentStatus.hasActive,
                hasRunningAgents: agentStatus.hasRunning,
                hasWaitingForUser: !!agentStatus.waitingForUser,
              });
              attachTeamTasks(card, teamTaskDir, dir.name, counts);
              sessionsMap.set(leaderId, card);
            }
            continue;
          }
          const existing = sessionsMap.get(leaderId);
          if (existing) {
            existing.isTeam = true;
            existing.teamName = dir.name;
            existing.memberCount = cfg.members?.length || 0;
            existing.name = existing.name || cfg.name || dir.name;
            teamLeaderIds.add(leaderId);
            // Attach team-named task directory if present.
            // Prefer team task dir over an empty session-UUID task dir — when a team session has
            // both a UUID-named dir (often empty: just .lock/.highwatermark) and a team-named dir
            // holding the real tasks, the leader card otherwise shows 0/0.
            const teamTaskDir = path.join(TASKS_DIR, dir.name);
            if (existsSync(teamTaskDir)) {
              attachTeamTasks(existing, teamTaskDir, dir.name, getTaskCounts(teamTaskDir));
            }
            // Re-check agent status with isTeam=true
            const agentDir = path.join(AGENT_ACTIVITY_DIR, leaderId);
            const logStat = getSessionLogStat(metadata[leaderId] || {});
            const logAge = logStat.mtime ? Date.now() - logStat.mtime : Infinity;
            const agentStatus = checkAgentStatus(agentDir, logAge > AGENT_STALE_MS, logStat.mtime, true);
            existing.hasActiveAgents = agentStatus.hasActive;
            existing.hasRunningAgents = agentStatus.hasRunning;
          }
        }
      } catch (_) {}
    }

    // Correlate plan sessions with their implementation sessions (same slug)
    const slugGroups = new Map();
    for (const [_sid, session] of sessionsMap) {
      if (session.slug) {
        if (!slugGroups.has(session.slug)) slugGroups.set(session.slug, []);
        slugGroups.get(session.slug).push(session);
      }
    }
    for (const [_slug, group] of slugGroups) {
      if (group.length < 2) continue;
      group.sort((a, b) => new Date(a.modifiedAt) - new Date(b.modifiedAt));
      const planSession = group.find(s => s.hasPlan);
      const linkedSession = group.find(s => s !== planSession && !s.hasPlan && new Date(s.modifiedAt) >= new Date(planSession?.modifiedAt || 0));
      if (planSession && linkedSession) {
        planSession.hasWaitingForUser = false;
        planSession.planImplementationSessionId = linkedSession.id;
        linkedSession.planSourceSessionId = planSession.id;
      }
    }

    // Suppress parent sessions that have a compact continuation — compaction is involuntary
    // (context limit hit), not an intentional fork. Only the continuation is shown.
    // A fork off an already-compacted transcript looks identical from the metadata alone
    // (its copied compact_boundary gives the child a logicalParentUuid), so the verdict
    // comes from lookupParentSession, not from the anchor's presence.
    const compactSuppressed = new Set();
    for (const [sid] of sessionsMap) {
      // Cheap pre-gate: only a session with a boundary anchor can be a continuation,
      // and lookupParentSession reads JSONLs on a cold cache.
      if (!metadata[sid]?.logicalParentUuid) continue;
      const parent = lookupParentSession(sid);
      if (parent.relation !== 'compact' || !sessionsMap.has(parent.parentSessionId)) continue;
      compactSuppressed.add(parent.parentSessionId);
      sessionsMap.get(sid).continuedFromSessionId = parent.parentSessionId;
    }
    // Invariant: a running process is never a superseded lineage, whatever the heuristics say.
    if (compactSuppressed.size) {
      for (const s of loadLiveSessions()) compactSuppressed.delete(s.sessionId);
    }
    for (const sid of compactSuppressed) sessionsMap.delete(sid);

    // Backfill contextStatus for already-built sessions that are pinned
    for (const pid of pinnedIds) {
      const s = sessionsMap.get(pid);
      if (s && !s.contextStatus) {
        const meta = metadata[pid];
        s.contextStatus = getContextStatus(pid, meta);
      }
    }

    // Ensure pinned sessions are in the map even if they weren't discovered
    for (const pid of pinnedIds) {
      if (sessionsMap.has(pid)) continue;
      const meta = metadata[pid];
      if (!meta) continue;
      const pinnedLogStat = getSessionLogStat(meta);
      const pinnedLogMtime = pinnedLogStat.mtime;
      let modifiedAt = meta.created || null;
      if (pinnedLogMtime) {
        const jsonlMtime = new Date(pinnedLogMtime).toISOString();
        if (!modifiedAt || jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
      }
      sessionsMap.set(pid, buildSessionObject(pid, meta, {
        _logStat: pinnedLogStat,
        modifiedAt: modifiedAt || new Date(0).toISOString(),
      }));
    }

    // Server-side activity filter (mirrors the client predicate in public/app.js).
    // Pinned IDs bypass — they should always be in the response.
    if (activeFilter) {
      const isActive = (s) =>
        s.hasMessages && (
          (!s.sharedTaskList && (s.pending > 0 || s.inProgress > 0))
          || s.hasActiveAgents
          || s.hasWaitingForUser
          || s.hasRecentActivity
        );
      for (const [id, s] of sessionsMap) {
        if (pinnedIds.has(id)) continue;
        if (!isActive(s)) sessionsMap.delete(id);
      }
    }

    // Convert map to array and sort by most recently modified
    let sessions = Array.from(sessionsMap.values());
    sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

    // Apply project filter before limit so the limit is per-project
    const projectFilter = req.query.project;
    if (projectFilter) {
      sessions = sessions.filter(s => s.project === projectFilter);
    }

    // Apply limit if specified, but always include pinned sessions
    if (limit !== null && limit > 0) {
      const top = sessions.slice(0, limit);
      const topIds = new Set(top.map(s => s.id));
      const missingPinned = sessions.filter(s => pinnedIds.has(s.id) && !topIds.has(s.id));
      sessions = [...top, ...missingPinned];
    }

    res.json(sessions);
  } catch (error) {
    console.error('Error listing sessions:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// API: Get distinct project paths with last-modified timestamps
app.get('/api/projects', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const metadata = loadSessionMetadata();
  const projectMap = {};
  for (const meta of Object.values(metadata)) {
    if (!meta.project) continue;
    const mtime = getSessionLogStat(meta).mtime;
    if (!projectMap[meta.project] || (mtime && mtime > projectMap[meta.project])) {
      projectMap[meta.project] = mtime;
    }
  }
  const projects = Object.entries(projectMap)
    .map(([path, mtime]) => ({ path, modifiedAt: mtime ? new Date(mtime).toISOString() : null }))
    .sort((a, b) => a.path.localeCompare(b.path));
  res.json(projects);
});

// API: Get tasks for a session
app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const sessionPath = taskDirFor(req.params.sessionId);

    if (!existsSync(sessionPath)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
    const tasks = [];

    for (const file of taskFiles) {
      try {
        const task = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
        tasks.push(task);
      } catch (e) {
        console.error(`Error parsing ${file}:`, e);
      }
    }

    // Sort by ID (numeric)
    tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));

    res.json(tasks);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// API: Get combined tasks for a project (all sessions + shared task lists)
app.get('/api/projects/:encodedPath/tasks', (req, res) => {
  try {
    const projectPath = Buffer.from(req.params.encodedPath, 'base64').toString('utf8');
    const metadata = loadSessionMetadata();
    const { sessionToList } = loadAllTaskMaps();

    const projectSessionIds = Object.entries(metadata)
      .filter(([, m]) => m.project === projectPath)
      .map(([id]) => id);

    const taskDirs = new Set();
    for (const sid of projectSessionIds) {
      const listName = sessionToList[sid];
      if (listName) {
        const dir = path.join(TASKS_DIR, listName);
        if (existsSync(dir)) taskDirs.add(dir);
      } else {
        const dir = path.join(TASKS_DIR, sid);
        if (existsSync(dir)) taskDirs.add(dir);
      }
    }

    const tasks = [];
    const seenKeys = new Set();
    for (const dir of taskDirs) {
      for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        try {
          const task = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
          const key = `${dir}:${task.id}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            task._taskDir = path.basename(dir);
            tasks.push(task);
          }
        } catch (_) {}
      }
    }
    tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    res.json(tasks);
  } catch (error) {
    console.error('Error getting project tasks:', error);
    res.status(500).json({ error: 'Failed to get project tasks' });
  }
});

// API: Get session plan
app.get('/api/sessions/:sessionId/plan', async (req, res) => {
  try {
    const metadata = loadSessionMetadata();
    const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
    const slug = meta?.slug;
    if (!slug) return res.status(404).json({ error: 'No plan found' });

    const planPath = path.join(PLANS_DIR, `${slug}.md`);
    if (!existsSync(planPath)) return res.status(404).json({ error: 'No plan found' });

    const content = await fs.readFile(planPath, 'utf8');
    res.json({ content, slug });
  } catch (error) {
    console.error('Error reading plan:', error);
    res.status(500).json({ error: 'Failed to read plan' });
  }
});

app.get('/api/sessions/:sessionId/loop', (req, res) => {
  try {
    const metadata = loadSessionMetadata();
    const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
    if (!meta?.jsonlPath) return res.json({ wakeups: [], crons: [] });
    const state = refreshLoopInfoState(meta.jsonlPath);
    const filtered = filterActiveLoopInfo(buildLoopInfoFromState(state));
    res.json({
      wakeups: [...filtered.wakeups].reverse(),
      crons: [...filtered.crons].reverse()
    });
  } catch (error) {
    console.error('Error reading loop info:', error);
    res.status(500).json({ error: 'Failed to read loop info' });
  }
});

// API: List workflow scripts for a session. Parses each script's meta for the
// canonical name + description (cold path — only when the workflow modal opens).
app.get('/api/sessions/:sessionId/workflows', async (req, res) => {
  try {
    const scripts = getWorkflowScripts(req.params.sessionId);
    const workflows = await Promise.all(
      scripts.map(async (w) => {
        let meta = {};
        try { meta = parseWorkflowMeta(await fs.readFile(w.path, 'utf8')); } catch (_) {}
        return {
          id: w.id,
          name: meta.name || w.name,
          description: meta.description || null,
          modifiedAt: w.mtimeMs ? new Date(w.mtimeMs).toISOString() : null,
        };
      }),
    );
    res.json({ workflows });
  } catch (error) {
    console.error('Error listing workflows:', error);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// API: Get a single workflow script's source. Looked up by id from the session's
// own script list (never built from the param), so the id can't traverse paths.
app.get('/api/sessions/:sessionId/workflows/:wfId', async (req, res) => {
  try {
    const wf = getWorkflowScripts(req.params.sessionId).find((w) => w.id === req.params.wfId);
    if (!wf) return res.status(404).json({ error: 'Workflow script not found' });
    const content = await fs.readFile(wf.path, 'utf8');
    res.json({ id: wf.id, name: wf.name, content });
  } catch (error) {
    console.error('Error reading workflow script:', error);
    res.status(500).json({ error: 'Failed to read workflow script' });
  }
});

// #endregion

// #region WORKFLOWS
// meta.phases and meta.name/description are pure literals per the Workflow tool
// contract, so pull them by regex rather than executing the untrusted script.
// name/description take the first match (the meta block is at the top of the file).
// Pull a quoted string value for `key` out of `src` (matches ', ", or `).
function matchStr(src, key) {
  const m = src.match(new RegExp(`${key}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`));
  return m ? m[2] : null;
}

function parseWorkflowMeta(source) {
  const meta = { name: matchStr(source, 'name'), description: matchStr(source, 'description'), phases: [] };
  const phasesM = source.match(/phases\s*:\s*\[([\s\S]*?)\]/);
  if (phasesM) {
    for (const m of phasesM[1].matchAll(/\{[\s\S]*?\}/g)) {
      const title = matchStr(m[0], 'title');
      if (title) meta.phases.push({ title, detail: matchStr(m[0], 'detail') });
    }
  }
  return meta;
}

// journal.jsonl records {type:'started',agentId} then {type:'result',agentId,...}
// per workflow agent. Map agentId → {started, done}; done count matches the
// "N/M agents" ratio the /workflows viewer shows.
function readWorkflowJournal(runDir) {
  const status = new Map();
  let content;
  try { content = readFileSync(path.join(runDir, 'journal.jsonl'), 'utf8'); } catch { return status; }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.agentId) continue;
    const e = status.get(o.agentId) || { started: false, done: false };
    if (o.type === 'started') e.started = true;
    else if (o.type === 'result') e.done = true;
    status.set(o.agentId, e);
  }
  return status;
}

// A workflow's run artifacts (journal + agent transcripts) live at
// <sessionDir>/subagents/workflows/<wfId>/. The script itself sits under
// <sessionDir>/workflows/scripts/, so the run dir is derivable from the script
// path with no I/O — try that first. Fall back to the session dir from metadata,
// then to scanning every project/session (the session dir can sit under a
// different projEnc than the script when a workflow runs from another cwd). wfId
// comes from the trusted script index (validated filename), so it can't
// traverse. Cold path only.
function resolveWorkflowRunDir(meta, wfId, scriptPath) {
  const rel = path.join('subagents', 'workflows', wfId);
  if (scriptPath) {
    const sessionDir = path.dirname(path.dirname(path.dirname(scriptPath)));
    const fromScript = path.join(sessionDir, rel);
    if (existsSync(fromScript)) return fromScript;
  }
  if (meta.jsonlPath) {
    const local = path.join(sessionDirFromMeta(meta), rel);
    if (existsSync(local)) return local;
  }
  try {
    for (const proj of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const projPath = path.join(PROJECTS_DIR, proj.name);
      let sessDirs;
      try { sessDirs = readdirSync(projPath, { withFileTypes: true }); } catch { continue; }
      for (const s of sessDirs) {
        if (!s.isDirectory()) continue;
        const cand = path.join(projPath, s.name, rel);
        if (existsSync(cand)) return cand;
      }
    }
  } catch {}
  return null;
}

// API: Workflow run state — declared phases (from the script) plus the agent
// roster (type/model/output-tokens/duration/status) reconstructed from the run
// dir's journal + transcripts. Phase↔agent mapping and per-agent labels are
// runtime-only and never persisted, so the roster is flat by design.
app.get('/api/sessions/:sessionId/workflows/:wfId/run', async (req, res) => {
  try {
    const wf = getWorkflowScripts(req.params.sessionId).find((w) => w.id === req.params.wfId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    let source = '';
    try { source = await fs.readFile(wf.path, 'utf8'); } catch (_) {}
    const parsed = parseWorkflowMeta(source);

    const sessionId = resolveSessionId(req.params.sessionId);
    const meta = loadSessionMetadata()[sessionId] || {};
    const runDir = resolveWorkflowRunDir(meta, wf.id, wf.path);
    const journal = runDir ? readWorkflowJournal(runDir) : new Map();

    const agents = [];
    let stoppedAt = null;
    if (runDir) {
      let files = [];
      try { files = readdirSync(runDir).filter((f) => /^agent-.+\.jsonl$/.test(f)); } catch (_) {}
      for (const f of files) {
        const agentId = f.slice('agent-'.length, -'.jsonl'.length);
        const stats = extractTranscriptStats(path.join(runDir, f)) || {};
        let type = null;
        try {
          type = JSON.parse(readFileSync(path.join(runDir, `agent-${agentId}.meta.json`), 'utf8')).agentType || null;
        } catch (_) {}
        const done = journal.get(agentId)?.done;
        const durationMs = stats.firstTs && stats.lastTs ? new Date(stats.lastTs) - new Date(stats.firstTs) : null;
        if (stats.lastTs && (!stoppedAt || stats.lastTs > stoppedAt)) stoppedAt = stats.lastTs;
        agents.push({
          agentId,
          type,
          model: stats.model || null,
          outputTokens: stats.outputTokens || 0,
          durationMs,
          startedAt: stats.firstTs || null,
          status: done ? 'done' : 'running',
        });
      }
      agents.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''));
    }
    // Roster is start-ordered, so the earliest start is simply the first agent.
    const startedAt = agents[0]?.startedAt || null;

    let startedCount = 0;
    let doneCount = 0;
    for (const e of journal.values()) {
      if (e.started) startedCount++;
      if (e.done) doneCount++;
    }
    if (!startedCount) {
      startedCount = agents.length;
      doneCount = agents.filter((a) => a.status === 'done').length;
    }

    res.json({
      id: wf.id,
      name: parsed.name || wf.name,
      description: parsed.description,
      phases: parsed.phases,
      agents,
      startedCount,
      doneCount,
      startedAt,
      stoppedAt,
    });
  } catch (error) {
    console.error('Error building workflow run view:', error);
    res.status(500).json({ error: 'Failed to build workflow run view' });
  }
});

// API: Open a workflow script in VS Code
app.post('/api/sessions/:sessionId/workflows/:wfId/open', (req, res) => {
  try {
    const wf = getWorkflowScripts(req.params.sessionId).find((w) => w.id === req.params.wfId);
    if (!wf) return res.status(404).json({ error: 'Workflow script not found' });
    openInEditor([wf.path]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error opening workflow script in editor:', error);
    res.status(500).json({ error: 'Failed to open workflow script' });
  }
});

// API: Open session plan in VS Code
app.post('/api/sessions/:sessionId/plan/open', (req, res) => {
  try {
    const metadata = loadSessionMetadata();
    const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
    const slug = meta?.slug;
    if (!slug) return res.status(404).json({ error: 'No plan found' });

    const planPath = path.join(PLANS_DIR, `${slug}.md`);
    if (!existsSync(planPath)) return res.status(404).json({ error: 'No plan found' });

    openInEditor([planPath]);
    res.json({ success: true });
  } catch (error) {
    console.error('Error opening plan in editor:', error);
    res.status(500).json({ error: 'Failed to open plan' });
  }
});

// #endregion

// #region OPEN_TARGETS
// API: Open folder (and optionally a file within it) in editor
app.post('/api/open-folder', (req, res) => {
  try {
    const { folder, file } = req.body;
    const targets = [folder ? assertOpenTarget(folder, 'folder') : CLAUDE_DIR];
    if (file) targets.push(assertOpenTarget(file, 'file'));
    openInEditor(targets);
    res.json({ success: true });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error opening folder:', error);
    res.status(500).json({ error: 'Failed to open folder' });
  }
});

// API: Open file in editor — either an existing path ({ file }) or content as a temp file ({ content, title })
app.post('/api/open-in-editor', (req, res) => {
  try {
    const { content, title, file } = req.body;
    if (file) {
      const resolved = assertOpenTarget(file, 'file');
      openInEditor([resolved]);
      return res.json({ success: true, path: resolved });
    }
    if (!content) return res.status(400).json({ error: 'No content provided' });

    const safeName = (title || 'message').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    const tmpFile = path.join(os.tmpdir(), `claude-kanban-${safeName}-${hash}.md`);
    require('node:fs').writeFileSync(tmpFile, content, 'utf8');

    openInEditor([tmpFile]);
    res.json({ success: true, path: tmpFile });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error opening in editor:', error);
    res.status(500).json({ error: 'Failed to open in editor' });
  }
});

// A scratchpad is a folder plus a `scratchpad.json` manifest, rendered by the
// external `scratch` CLI. cck only recognizes the shape and launches the viewer —
// it never parses the manifest, so the two stay independently versioned.
const SCRATCHPAD_MANIFEST = 'scratchpad.json';

// Resolve a linked path to the pad the viewer wants: `<parent>/<name>` where
// `<name>/scratchpad.json` exists. Accepts either the manifest or its directory.
function resolveScratchpad(value) {
  const target = assertOpenTarget(value, 'path');
  const dir = path.basename(target).toLowerCase() === SCRATCHPAD_MANIFEST ? path.dirname(target) : target;
  if (!existsSync(path.join(dir, SCRATCHPAD_MANIFEST))) throw previewError(400, 'Not a scratchpad');
  return { name: path.basename(dir), parent: path.dirname(dir) };
}

// API: Open a scratchpad in the external `scratch` viewer — the window outlives
// this request and cck never waits on it.
app.post('/api/scratchpad/open', (req, res) => {
  try {
    const bin = whichSync('scratch');
    if (!bin) return res.status(501).json({ error: 'scratch CLI not found on PATH' });
    const { name, parent } = resolveScratchpad(req.body?.path);
    // .cmd/.bat cannot be spawned without a shell since the CVE-2024-27980 fix;
    // scratch ships a real .exe, so resolve it rather than reintroducing one.
    const ext = path.extname(bin).toLowerCase();
    const file = ext === '.cmd' || ext === '.bat' ? exeBehindShim(bin) : bin;
    if (!file) return res.status(501).json({ error: 'scratch CLI cannot be launched without a shell' });
    // `scratch ui` is a foreground supervisor: it reloads the window on edits and
    // quits on stdin EOF. So stdin must be an open pipe we never write to —
    // 'ignore' is /dev/null, which reads as EOF and closes the viewer at once.
    //
    // And no `detached`: on Windows that means DETACHED_PROCESS, which overrides
    // the CREATE_NO_WINDOW `windowsHide` asks for, so the bun shim allocates its
    // own console and a blank terminal window pops up next to the viewer.
    const child = spawn(file, ['ui', name, '--dir', parent], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', (e) => console.error('scratch ui failed to start:', e.message));
    // Nothing is ever written to it, but an unhandled EPIPE when the user closes
    // the viewer would take the server down with it.
    child.stdin.on('error', () => {});
    child.stdin.unref();
    child.unref();
    res.json({ success: true, pad: name });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('Error opening scratchpad:', error);
    res.status(500).json({ error: 'Failed to open scratchpad' });
  }
});

// #endregion

// #region AGENT_ROUTES
// API: Get team config
app.get('/api/teams/:name', (req, res) => {
  const config = loadTeamConfig(req.params.name);
  if (!config) return res.status(404).json({ error: 'Team not found' });
  config.configPath = path.join(TEAMS_DIR, req.params.name, 'config.json');
  res.json(config);
});

// API: Get agents for a session
app.get('/api/sessions/:sessionId/agents', (req, res) => {
  const sessionId = resolveSessionId(req.params.sessionId);
  const agentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
  if (!existsSync(agentDir)) return res.json({ agents: [], waitingForUser: null });
  try {
    const metadata = loadSessionMetadata();
    const meta = metadata[sessionId] || {};
    const logMtime = getSessionLogStat(meta).mtime;
    const sessionStale = logMtime ? (Date.now() - logMtime) > AGENT_STALE_MS : true;

    let teamConfig = loadTeamConfig(req.params.sessionId);
    if (!teamConfig && existsSync(TEAMS_DIR)) {
      try {
        for (const td of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
          if (!td.isDirectory()) continue;
          const cfg = loadTeamConfig(td.name);
          if (cfg && cfg.leadSessionId === sessionId) { teamConfig = cfg; break; }
        }
      } catch (_) {}
    }
    const isTeam = !!teamConfig;
    const teamMemberNames = isTeam ? new Set(teamConfig.members.map(m => m.name)) : null;

    const files = listAgentFiles(agentDir);
    const agents = [];
    for (const file of files) {
      try {
        const agent = readAgentJsonl(path.join(agentDir, file));
        if (isGhostAgent(agent)) continue;
        const agentTs = agent.updatedAt || agent.startedAt;
        const agentStale = !sessionStale && agentTs && (Date.now() - new Date(agentTs).getTime()) > AGENT_STALE_MS;
        if (!isAgentFresh(agent) || sessionStale || agentStale) {
          if (isAgentLive(agent)) {
            const agentName = agentDisplayName(agent);
            const isTeamMember = isTeam && agentName && teamMemberNames.has(agentName);
            if (!isTeamMember) {
              agent.status = 'stopped';
              if (!agent.stoppedAt) agent.stoppedAt = agent.updatedAt || agent.startedAt;
            }
          }
        }
        agents.push(agent);
      } catch { /* skip invalid */ }
    }
    const liveAgents = agents.filter(isAgentLive);
    if (liveAgents.length && meta.jsonlPath) {
      try {
        const terminated = getTerminatedTeammates(meta.jsonlPath);
        if (terminated.size) {
          for (const agent of liveAgents) {
            const agentName = agentDisplayName(agent);
            if (agentName && terminated.has(agentName)) {
              const terminatedAt = terminated.get(agentName);
              if (terminatedAt && agent.startedAt && terminatedAt < agent.startedAt) continue;
              agent.status = 'stopped';
              agent.stoppedAt = agent.stoppedAt || new Date().toISOString();
              persistAgent(agentDir, agent);
            }
          }
        }
      } catch (_) {}
      // Mark agents whose spawning Agent tool_use was rejected by the user as stopped:
      // the parent will never read their output, so they're orphans. Match by agentId
      // when the digest already correlated tool_use→agent, else fall back to prompt text
      // (the agent-spy hook doesn't record the spawning tool_use_id).
      try {
        const { rejectedAgentIds = new Set(), rejectedPrompts = new Set(), killedAgentIds = new Set() } =
          getSessionDigest(meta.jsonlPath);
        if (rejectedAgentIds.size || rejectedPrompts.size || killedAgentIds.size) {
          for (const agent of liveAgents) {
            if (!isAgentLive(agent)) continue;
            let reason = null;
            if (killedAgentIds.has(agent.agentId)) reason = 'killed-by-harness';
            else if (rejectedAgentIds.has(agent.agentId) || (agent.prompt && rejectedPrompts.has(agent.prompt))) {
              reason = 'orphaned-by-rejection';
            }
            if (!reason) continue;
            agent.status = 'stopped';
            agent.stoppedAt = agent.stoppedAt || new Date().toISOString();
            agent.stopReason = agent.stopReason || reason;
            persistAgent(agentDir, agent);
          }
        }
      } catch (_) {}
    }

    const dirty = new Set();

    // Agents may be missing prompt/name/description because the parent's agent_progress
    // event or the subagent's own transcript hadn't been written yet at last poll. While
    // the agent is still active, keep retrying instead of latching *Unavailable permanently
    // (same pattern as agentsNeedingModel below). Each field shares the same resolve flow:
    // look up in progressMap by agentId, fall back to per-field extractor, persist only
    // on actual change.
    // progressMap is keyed by tool_use_id; re-key by agentId, first value per field wins.
    const byAgentId = {};
    if (meta.jsonlPath) {
      try {
        const progressMap = getProgressMap(meta.jsonlPath);
        for (const entry of Object.values(progressMap)) {
          const e = (byAgentId[entry.agentId] ||= {});
          for (const f of ['prompt', 'name', 'description', 'usage']) {
            if (entry[f] && !e[f]) e[f] = entry[f];
          }
        }
      } catch (_) {}
    }
    const reconcileFields = [
      {
        field: 'prompt',
        flag: 'promptUnavailable',
        lookup: (a) => {
          if (byAgentId[a.agentId]?.prompt) return byAgentId[a.agentId].prompt;
          try { return extractPromptFromTranscript(subagentJsonlForExtraction(meta, a.agentId)); } catch (_) { return null; }
        },
      },
      { field: 'agentName',   flag: 'agentNameUnavailable',   lookup: (a) => byAgentId[a.agentId]?.name || null },
      { field: 'description', flag: 'descriptionUnavailable', lookup: (a) => byAgentId[a.agentId]?.description || null },
    ];
    if (meta.jsonlPath) {
      for (const { field, flag, lookup } of reconcileFields) {
        for (const agent of agents) {
          if (agent[field]) continue;
          // Workflow subagents nest their transcript under subagents/workflows/;
          // pre-fix builds latched *Unavailable using the flat path, so always
          // re-attempt for them (the extractor resolves the nested path now).
          if (agent[flag] && !isAgentLive(agent) && agent.type !== 'workflow-subagent') continue;
          const value = lookup(agent);
          if (value) {
            agent[field] = value;
            delete agent[flag];
            dirty.add(agent);
          } else if (!isAgentLive(agent) && !agent[flag]) {
            agent[flag] = true;
            dirty.add(agent);
          }
        }
      }
    }

    // Retry stopped agents even if modelUnavailable was set — it may have been marked
    // unavailable while the agent was still active and its JSONL wasn't ready yet.
    const agentsNeedingModel = agents.filter(a => !a.model && (!a.modelUnavailable || a.status === 'stopped'));
    if (agentsNeedingModel.length && meta.jsonlPath) {
      for (const agent of agentsNeedingModel) {
        let model = null;
        try { model = extractModelFromTranscript(subagentJsonlForExtraction(meta, agent.agentId)); } catch (_) {}
        if (model) {
          agent.model = model;
          delete agent.modelUnavailable;
          dirty.add(agent);
        } else if (agent.status === 'stopped' && !agent.modelUnavailable) {
          agent.modelUnavailable = true;
          dirty.add(agent);
        }
      }
    }

    // Workflow-spawned subagents given a schema end on a forced StructuredOutput
    // tool call and never emit a text lastMessage — surface that structured result
    // as the agent's response. Only stopped agents (complete transcript); latch
    // resultUnavailable so we tail-read at most once per agent. Workflow subagents
    // are exempt from the latch: the poll that flips them to "stopped" can beat the
    // transcript's final StructuredOutput line to disk, latching resultUnavailable
    // against an incomplete transcript — so always re-attempt for them, mirroring
    // the prompt/name/description reconcile above.
    const agentsNeedingResult = agents.filter(
      (a) => !a.lastMessage && !isAgentLive(a) && (!a.resultUnavailable || a.type === 'workflow-subagent'),
    );
    if (agentsNeedingResult.length && meta.jsonlPath) {
      for (const agent of agentsNeedingResult) {
        let result = null;
        try { result = extractStructuredResultFromTranscript(subagentJsonlForExtraction(meta, agent.agentId)); } catch (_) {}
        if (result) agent.lastMessage = result;
        else agent.resultUnavailable = true;
        dirty.add(agent);
      }
    }

    for (const agent of dirty) persistAgent(agentDir, agent);
    const teamColors = {};
    if (teamConfig?.members) {
      for (const m of teamConfig.members) {
        if (m.name && m.color) teamColors[m.name] = m.color;
      }
      if (Object.keys(teamColors).length) {
        for (const agent of agents) {
          const name = agentDisplayName(agent);
          if (name && teamColors[name]) agent.color = teamColors[name];
        }
      }
    }

    // Collapse teammate re-spawns: when a teammate goes idle and is later re-engaged,
    // a fresh agentId is spawned. Hide older idle/stopped entries when a newer same-name
    // teammate exists; never hide an `active` agent (parallel teammate work would vanish).
    // Subagents (Explore, general-purpose, etc.) are not in teamMemberNames and bypass
    // dedup entirely, so parallel siblings of the same subagent type remain visible.
    let visibleAgents = agents;
    if (teamMemberNames?.size) {
      const groups = new Map();
      for (const a of agents) {
        const t = agentDisplayName(a);
        if (!t || !teamMemberNames.has(t)) continue;
        const list = groups.get(t) || [];
        list.push(a);
        groups.set(t, list);
      }
      const hidden = new Set();
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
        for (const older of list.slice(1)) {
          if (older.status === 'idle' || older.status === 'stopped') hidden.add(older.agentId);
        }
      }
      if (hidden.size) visibleAgents = agents.filter(a => !hidden.has(a.agentId));
    }

    const waitingForUser = checkWaitingForUser(agentDir, logMtime);
    // Attached after persistAgent so it stays response-only.
    for (const agent of visibleAgents) {
      const usage = byAgentId[agent.agentId]?.usage;
      if (usage) agent.usage = usage;
    }
    res.json({ agents: visibleAgents, waitingForUser, teamColors });
  } catch {
    res.json({ agents: [], waitingForUser: null });
  }
});

function clearWaitingFile(sessionId) {
  try { unlinkSync(path.join(AGENT_ACTIVITY_DIR, sessionId, '_waiting.json')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

app.post('/api/sessions/:sessionId/waiting/discard', (req, res) => {
  try {
    clearWaitingFile(resolveSessionId(req.params.sessionId));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to discard waiting' });
  }
});

// UI-driven approvals: answers the ask approval-gate.sh is blocking on by
// writing _decision-<id>.json next to the marker. The hook consumes and deletes
// both files; a write for a hook that already gave up is accepted anyway (D13)
// and left for cleanupAgentActivity's sweep.
app.post('/api/sessions/:sessionId/waiting/respond', (req, res) => {
  const sessionId = resolveSessionId(req.params.sessionId);
  const dir = path.join(AGENT_ACTIVITY_DIR, sessionId);
  let marker = null;
  try { marker = JSON.parse(readFileSync(path.join(dir, '_waiting.json'), 'utf8')); }
  catch { /* missing or invalid → buildDecision reports 410 */ }
  // The gate stopped polling after waitSeconds — an orphaned decision file would
  // sit unconsumed while the card pretends the click worked.
  if (marker && isWaitingLapsed(marker)) {
    return res.status(410).json({ error: 'Ask lapsed — answer it in the terminal' });
  }
  const result = buildDecision(marker, req.body || {});
  if (result.error) return res.status(result.status).json({ error: result.error });
  try {
    writeJsonAtomic(path.join(dir, decisionFileName(marker.id)), result.decision);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to write decision' });
  }
});

app.post('/api/sessions/:sessionId/agents/:agentId/stop', (req, res) => {
  const sessionId = resolveSessionId(req.params.sessionId);
  const agentId = sanitizeAgentId(req.params.agentId);
  const agentFile = path.join(AGENT_ACTIVITY_DIR, sessionId, `${agentId}.jsonl`);
  if (!existsSync(agentFile)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const agent = readAgentJsonl(agentFile);
    agent.status = 'stopped';
    agent.stoppedAt = new Date().toISOString();
    const stopEvt = { agentId, type: agent.type, event: 'user-stop', status: 'stopped', stoppedAt: agent.stoppedAt, updatedAt: agent.stoppedAt };
    writeFileSync(agentFile, `${readFileSync(agentFile, 'utf8') + JSON.stringify(stopEvt)}\n`, 'utf8'); // sync — response depends on write
    clearWaitingFile(sessionId);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to stop agent' });
  }
});

// #endregion

// #region SUBAGENT_RESOLUTION
function sanitizeAgentId(raw) {
  return path.basename(raw).replace(/[^a-zA-Z0-9_-]/g, '');
}

function sessionDirFromMeta(meta) {
  return path.join(path.dirname(meta.jsonlPath), path.basename(meta.jsonlPath, '.jsonl'));
}

function subagentJsonlPath(meta, agentId) {
  return path.join(sessionDirFromMeta(meta), 'subagents', `agent-${agentId}.jsonl`);
}

// A subagent transcript is normally at <sessionDir>/subagents/agent-<id>.jsonl.
// Workflow-tool subagents nest one level deeper, under
// <sessionDir>/subagents/workflows/<wf_id>/agent-<id>.jsonl. Return whichever
// exists (flat first), else null.
function subagentJsonlInDir(sessionDir, agentId) {
  const flat = path.join(sessionDir, 'subagents', `agent-${agentId}.jsonl`);
  if (existsSync(flat)) return flat;
  const wfRoot = path.join(sessionDir, 'subagents', 'workflows');
  let wfDirs;
  try { wfDirs = readdirSync(wfRoot, { withFileTypes: true }); } catch { return null; }
  for (const wf of wfDirs) {
    if (!wf.isDirectory()) continue;
    const nested = path.join(wfRoot, wf.name, `agent-${agentId}.jsonl`);
    if (existsSync(nested)) return nested;
  }
  return null;
}

// Path for prompt/model extraction in agent enrichment: prefer the nested
// workflow-subagent transcript when the flat path is absent. Falls back to the
// flat path (which extract* handle gracefully when missing).
function subagentJsonlForExtraction(meta, agentId) {
  const resolved = meta.jsonlPath ? subagentJsonlInDir(sessionDirFromMeta(meta), agentId) : null;
  return resolved || subagentJsonlPath(meta, agentId);
}

// Claude Code can scatter a session's records across multiple project dirs
// (e.g. main repo + worktree) and across sibling sessionId dirs when a
// session is forked/resumed — the subagent JSONL stays under the original
// parent sessionId. Fall back to scanning when the derived path is missing.
const subagentPathCache = new Map();
function findSubagentJsonlInProject(projPath, sessionId, agentId) {
  const sameSid = subagentJsonlInDir(path.join(projPath, sessionId), agentId);
  if (sameSid) return sameSid;
  let sessions;
  try { sessions = readdirSync(projPath, { withFileTypes: true }); } catch { return null; }
  for (const sess of sessions) {
    if (!sess.isDirectory() || sess.name === sessionId) continue;
    const candidate = subagentJsonlInDir(path.join(projPath, sess.name), agentId);
    if (candidate) return candidate;
  }
  return null;
}
function resolveSubagentJsonl(meta, sessionId, agentId) {
  // Same session dir: flat path or nested under subagents/workflows/ (both checked here).
  const local = meta.jsonlPath ? subagentJsonlInDir(sessionDirFromMeta(meta), agentId) : null;
  if (local) return local;
  const key = `${sessionId}/${agentId}`;
  const cached = subagentPathCache.get(key);
  if (cached) return cached;
  let found = null;
  const parent = lookupParentSession(sessionId);
  if (parent.parentSessionId && parent.parentJsonlPath) {
    const projDir = path.dirname(parent.parentJsonlPath);
    const candidate = subagentJsonlInDir(path.join(projDir, parent.parentSessionId), agentId);
    if (candidate) found = candidate;
  }
  if (!found) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        found = findSubagentJsonlInProject(path.join(PROJECTS_DIR, proj.name), sessionId, agentId);
        if (found) break;
      }
    } catch (_) { /* projects dir missing */ }
  }
  if (found) subagentPathCache.set(key, found);
  return found || subagentJsonlPath(meta, agentId);
}

// Claude Code creates child sessions in two ways:
//   Fork: copies the parent's early messages verbatim (same UUIDs). Anchor = first UUID.
//   Compact: writes a compact_boundary record with logicalParentUuid in the preamble.
// Birthtime (not mtime) identifies the parent — mtime changes on resume, birthtime is immutable.
const parentSessionCache = new Map();
const FORK_ANCHOR_SCAN_LINES = 10;
function findForkAnchorUuid(jsonlPath) {
  let text;
  try { text = readFileSync(jsonlPath, 'utf8'); } catch { return null; }
  let firstUuid = null, scanned = 0;
  for (const l of text.split('\n')) {
    if (!l) continue;
    if (scanned++ >= FORK_ANCHOR_SCAN_LINES) break;
    try { const d = JSON.parse(l); if (!firstUuid && d.uuid) firstUuid = d.uuid; } catch { /* skip malformed */ }
  }
  return firstUuid;
}
// Fallback when the metadata cache lacks the boundary pair (older entries, cold cache).
// Reached only from lookupParentSession, whose result is memoized for the process life —
// at most one read per session, never per request.
// Bounded read (~1 MB) mirrors readSessionInfoFromJsonl's HEAD_MAX — compact_boundary
// always sits in the preamble before the first user/assistant record.
const COMPACT_ANCHOR_READ_MAX = 1048576;
// Returns { anchor, boundaryUuid } for the preamble compact_boundary, or null.
function findCompactBoundary(jsonlPath) {
  let fd;
  try {
    fd = openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(COMPACT_ANCHOR_READ_MAX);
    const n = readSync(fd, buf, 0, COMPACT_ANCHOR_READ_MAX, 0);
    const text = buf.toString('utf8', 0, n);
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl) : text;
    for (const l of complete.split('\n')) {
      if (!l) continue;
      try {
        const d = JSON.parse(l);
        if (d.type === 'user' || d.type === 'assistant') return null;
        if (d.subtype === 'compact_boundary' && d.logicalParentUuid) {
          return { anchor: d.logicalParentUuid, boundaryUuid: d.uuid || null };
        }
      } catch { /* skip malformed */ }
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}
// forkProbeUuid (optional): the child's own compact_boundary uuid. It only shows up
// in the parent when the child copied the record — i.e. a fork off an already-compacted
// transcript, not a compact continuation. Probed once, on the winner's text, which the
// scan already read.
function findSessionContainingUuid(projectDir, targetUuid, excludeJsonlPath, maxBirthtimeMs, forkProbeUuid) {
  let files;
  try { files = readdirSync(projectDir); } catch { return null; }
  let best = null, bestBirthtime = Infinity, bestText = null;
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(projectDir, f);
    if (fp === excludeJsonlPath) continue;
    let birthtime = 0;
    try { birthtime = statSync(fp).birthtimeMs; } catch { continue; }
    if (maxBirthtimeMs != null && birthtime >= maxBirthtimeMs) continue;
    if (birthtime >= bestBirthtime) continue;
    let text;
    try { text = readFileSync(fp, 'utf8'); } catch { continue; }
    if (!text.includes(targetUuid)) continue;
    for (const l of text.split('\n')) {
      if (!l?.includes(targetUuid)) continue;
      try {
        const d = JSON.parse(l);
        if (d.uuid === targetUuid && d.sessionId) {
          best = { parentSessionId: d.sessionId, parentJsonlPath: fp, isFork: false };
          bestBirthtime = birthtime;
          bestText = text;
          break;
        }
      } catch { /* skip */ }
    }
  }
  if (!best) return null;
  if (forkProbeUuid) best.isFork = bestText.includes(forkProbeUuid);
  return best;
}
function lookupParentSession(sessionId) {
  if (parentSessionCache.has(sessionId)) return parentSessionCache.get(sessionId);
  const meta = loadSessionMetadata()[sessionId];
  // relation is the single verdict: 'none' (no parent found), 'compact' (this session
  // continues a lineage the parent could not hold) or 'fork' (an intentional branch off
  // a parent that keeps its own life). isCompact/isFork are derived views of it.
  const result = { parentSessionId: null, parentJsonlPath: null, relation: 'none', isCompact: false, isFork: false };
  if (meta?.jsonlPath) {
    // Metadata entries cached before compactBoundaryUuid existed carry the anchor
    // without the boundary uuid — re-read rather than lose fork detection.
    const boundary = (meta.logicalParentUuid && meta.compactBoundaryUuid)
      ? { anchor: meta.logicalParentUuid, boundaryUuid: meta.compactBoundaryUuid }
      : findCompactBoundary(meta.jsonlPath);
    const compactAnchor = boundary?.anchor ?? meta.logicalParentUuid ?? null;
    // A fork copies the parent's early records verbatim, so its first uuid is the anchor.
    const anchorUuid = compactAnchor ?? findForkAnchorUuid(meta.jsonlPath);
    if (anchorUuid) {
      let selfBirthtime;
      try { selfBirthtime = statSync(meta.jsonlPath).birthtimeMs; } catch { /* ignore */ }
      if (selfBirthtime != null) {
        const hit = findSessionContainingUuid(path.dirname(meta.jsonlPath), anchorUuid, meta.jsonlPath, selfBirthtime, boundary?.boundaryUuid);
        if (hit) {
          // No compact boundary at all → fork by construction; with one, the copied
          // boundary uuid (hit.isFork) is what separates a fork from a continuation.
          result.parentSessionId = hit.parentSessionId;
          result.parentJsonlPath = hit.parentJsonlPath;
          result.relation = (!compactAnchor || hit.isFork) ? 'fork' : 'compact';
        }
      }
    }
  }
  result.isCompact = result.relation === 'compact';
  result.isFork = result.relation === 'fork';
  parentSessionCache.set(sessionId, result);
  return result;
}
// #endregion

// #region MESSAGE_ROUTES
app.get('/api/sessions/:sessionId/parent', (req, res) => {
  res.json(lookupParentSession(resolveSessionId(req.params.sessionId)));
});

app.get('/api/sessions/:sessionId/agents/:agentId/messages', (req, res) => {
  const sessionId = resolveSessionId(req.params.sessionId);
  const agentId = sanitizeAgentId(req.params.agentId);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const metadata = loadSessionMetadata();
  const meta = metadata[sessionId];
  if (!meta?.jsonlPath) return res.json({ messages: [], agentId });
  const subagentJsonl = resolveSubagentJsonl(meta, sessionId, agentId);
  if (!existsSync(subagentJsonl)) return res.json({ messages: [], agentId });
  const messages = readRecentMessages(subagentJsonl, limit);
  res.json({ messages, agentId });
});

app.get('/api/sessions/:sessionId/agents/:agentId/messages/stream', (req, res) => {
  const sessionId = resolveSessionId(req.params.sessionId);
  const agentId = sanitizeAgentId(req.params.agentId);
  const metadata = loadSessionMetadata();
  const meta = metadata[sessionId];
  if (!meta?.jsonlPath) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const subagentJsonl = resolveSubagentJsonl(meta, sessionId, agentId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  let lastSize = existsSync(subagentJsonl) ? statSync(subagentJsonl).size : 0;

  const watcher = chokidar.watch(subagentJsonl, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
  });

  let closed = false;
  const cleanup = () => { if (!closed) { closed = true; watcher.close(); } };

  function emitMessages() {
    const messages = readRecentMessages(subagentJsonl, 50);
    lastSize = statSync(subagentJsonl).size;
    res.write(`event: agent-log-update\ndata: ${JSON.stringify({ messages, agentId })}\n\n`);
  }

  watcher.on('change', () => {
    try {
      if (statSync(subagentJsonl).size <= lastSize) return;
      emitMessages();
    } catch (_) {}
  });

  watcher.on('add', () => {
    try { emitMessages(); } catch (_) {}
  });

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
});

app.get('/api/sessions/:sessionId/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const before = req.query.before || null;
  const metadata = loadSessionMetadata();
  const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.json({ messages: [], hasMore: false, sessionId: req.params.sessionId });
  let messages, hasMore;
  if (before) {
    const page = _readMessagesPageUncached(jsonlPath, limit, before);
    messages = page.messages;
    hasMore = page.hasMore;
  } else {
    messages = readRecentMessages(jsonlPath, limit + 1);
    hasMore = messages.length > limit;
    if (hasMore) messages = messages.slice(-limit);
  }
  const agentMessages = messages.filter(m => m.tool === 'Agent' && m.toolUseId);
  if (agentMessages.length) {
    const progressMap = getProgressMap(jsonlPath);
    const resolvedSid = resolveSessionId(req.params.sessionId);
    const agentDir = path.join(AGENT_ACTIVITY_DIR, resolvedSid);
    for (const msg of agentMessages) {
      const entry = progressMap[msg.toolUseId];
      if (entry) {
        msg.agentId = entry.agentId;
        if (entry.description) msg.agentDescription = entry.description;
        if (entry.usageText) msg.agentUsage = entry.usageText;
        if (entry.prompt && !msg.agentPrompt) msg.agentPrompt = entry.prompt;
        try {
          const agentFile = path.join(agentDir, `${entry.agentId}.jsonl`);
          const agent = readAgentJsonl(agentFile);
          if (agent.lastMessage) msg.agentLastMessage = agent.lastMessage;
          if (agent.prompt && !msg.agentPrompt) msg.agentPrompt = agent.prompt;
          const prompt = msg.agentPrompt || entry.prompt;
          if (prompt && !agent.prompt) {
            agent.prompt = prompt;
            persistAgent(agentDir, agent);
          }
        } catch (_) {}
      }
    }
    // Mid-run fallback: the progressMap only carries agentId once the agent completes
    // (this build writes no agent_progress lines), so a still-running subagent's launch
    // row has no agentId yet — leaving its ⇗ link / agent modal inert until completion.
    // Correlate by PROMPT against the live agent-activity files (which know the agentId
    // from launch): the activity prompt is the launch prompt plus appended harness
    // boilerplate, so the tool_use prompt is a prefix. Resolving agentId here makes the
    // row behave identically while running as it does after it finishes.
    const unresolved = agentMessages.filter(m => !m.agentId && m.agentPrompt);
    if (unresolved.length && existsSync(agentDir)) {
      const activity = listAgentFiles(agentDir)
        .map((f) => { try { return readAgentJsonl(path.join(agentDir, f)); } catch (_) { return null; } })
        .filter((a) => a?.agentId && a.prompt);
      const usedIds = new Set(agentMessages.map(m => m.agentId).filter(Boolean));
      for (const msg of unresolved) {
        const key = msg.agentPrompt.slice(0, 200);
        const match = activity.find(a =>
          !usedIds.has(a.agentId) &&
          (!msg.agentType || a.type === msg.agentType) &&
          a.prompt.startsWith(key)
        );
        if (match) {
          msg.agentId = match.agentId;
          usedIds.add(match.agentId);
          if (match.lastMessage) msg.agentLastMessage = match.lastMessage;
        }
      }
    }
  }
  const cachedCompact = compactSummaryCache.get(jsonlPath);
  let compactSummaries;
  if (cachedCompact && Date.now() - cachedCompact.ts < MESSAGE_CACHE_TTL) {
    compactSummaries = cachedCompact.data;
  } else {
    compactSummaries = readCompactSummaries(jsonlPath);
    compactSummaryCache.set(jsonlPath, { data: compactSummaries, ts: Date.now() });
    evictStaleCache(compactSummaryCache);
  }
  // Match compaction messages to summaries by chronological order
  const compactedMsgs = messages
    .filter(m => m.systemLabel === 'Compacted')
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  for (let i = 0; i < compactedMsgs.length; i++) {
    if (i < compactSummaries.length) {
      compactedMsgs[i].compactSummary = compactSummaries[i].summary;
    }
  }
  // The client keeps needing toolUseId when it builds a follow-up URL from it:
  // lazy-fetching a truncated tool result, or fetching each tool-result image.
  const clientNeedsToolUseId = (msg) => msg.toolResultTruncated || msg.toolResultImageCount;
  for (const msg of messages) {
    if (msg.toolUseId && !clientNeedsToolUseId(msg)) delete msg.toolUseId;
    delete msg.promptId;
  }
  res.json({ messages, hasMore, sessionId: req.params.sessionId });
});

app.get('/api/sessions/:sessionId/tool-result/:toolUseId', (req, res) => {
  const metadata = loadSessionMetadata();
  const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).json({ error: 'session not found' });
  const content = readFullToolResult(jsonlPath, req.params.toolUseId);
  if (content == null) return res.status(404).json({ error: 'tool result not found' });
  res.json({ toolUseId: req.params.toolUseId, content });
});

const toolStatsCache = new Map();

function buildToolStats(jsonlPath) {
  const toolUseById = {};     // tool_use_id -> { displayName, isSkill }
  const seenResults = new Set();
  const toolMap = {};         // displayName -> { count, success, failed, outputBytes }
  const skillPromptIds = {};  // promptId -> [skillDisplayName, ...]
  const promptOutputBytes = {}; // promptId -> total outputBytes in that turn

  const content = readFileSync(jsonlPath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }

    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const block of obj.message.content) {
        if (block.type === 'tool_use' && block.name && block.id) {
          const isSkill = block.name === 'Skill';
          const displayName = isSkill && block.input?.skill
            ? `Skill(${block.input.skill})`
            : block.name === 'Agent' && block.input?.subagent_type
            ? `Agent(${block.input.subagent_type})`
            : block.name;
          toolUseById[block.id] = { displayName, isSkill };
        }
      }
    } else if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      const promptId = obj.promptId;
      for (const block of obj.message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const entry = toolUseById[block.tool_use_id];
        if (!entry) continue;
        const { displayName, isSkill } = entry;
        seenResults.add(block.tool_use_id);
        if (!toolMap[displayName]) toolMap[displayName] = { count: 0, success: 0, failed: 0, rejected: 0, outputBytes: 0 };
        toolMap[displayName].count++;
        const raw = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content) ? block.content.map(b => b.text || '').join('\n') : '';
        const bytes = raw.length;
        toolMap[displayName].outputBytes += bytes;
        if (promptId) {
          promptOutputBytes[promptId] = (promptOutputBytes[promptId] || 0) + bytes;
          if (isSkill) {
            if (!skillPromptIds[promptId]) skillPromptIds[promptId] = [];
            skillPromptIds[promptId].push(displayName);
          }
        }
        const isRejected = typeof obj.toolUseResult === 'string' && /rejected/i.test(obj.toolUseResult);
        if (isRejected) toolMap[displayName].rejected++;
        else {
          const lower = raw.toLowerCase();
          const failed = /^error/i.test(raw.trimStart())
            || /exit code [1-9]/.test(lower)
            || lower.includes('command failed')
            || (lower.includes('failed') && lower.includes('error'));
          if (failed) toolMap[displayName].failed++;
          else toolMap[displayName].success++;
        }
      }
    }
  }

  // Count tool_use blocks that never got a tool_result
  for (const [id, { displayName }] of Object.entries(toolUseById)) {
    if (seenResults.has(id)) continue;
    if (!toolMap[displayName]) toolMap[displayName] = { count: 0, success: 0, failed: 0, rejected: 0, outputBytes: 0 };
    toolMap[displayName].count++;
  }

  // Approximate Skill impact: replace tiny dispatch bytes with the full turn's output
  for (const [promptId, skillNames] of Object.entries(skillPromptIds)) {
    const turnBytes = promptOutputBytes[promptId] || 0;
    for (const name of skillNames) {
      if (toolMap[name]) toolMap[name].outputBytes = turnBytes;
    }
  }

  let totalCalls = 0, totalFailed = 0, totalRejected = 0, totalOutputBytes = 0;
  for (const s of Object.values(toolMap)) {
    totalCalls += s.count;
    totalFailed += s.failed;
    totalRejected += s.rejected;
    totalOutputBytes += s.outputBytes || 0;
  }
  const uniqueTools = Object.keys(toolMap).length;

  const tools = [];
  for (const [name, stats] of Object.entries(toolMap)) {
    const impact = totalOutputBytes > 0 ? Math.round((stats.outputBytes || 0) / totalOutputBytes * 100) : 0;
    const displayName = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;
    tools.push({ name: displayName, count: stats.count, success: stats.success, failed: stats.failed, rejected: stats.rejected, impact });
  }

  return { totalCalls, uniqueTools, totalFailed, totalRejected, tools };
}

app.get('/api/sessions/:sessionId/tool-stats', (req, res) => {
  const metadata = loadSessionMetadata();
  const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).json({ error: 'session not found' });
  try {
    const data = cachedByMtime(toolStatsCache, jsonlPath, jsonlPath, () => buildToolStats(jsonlPath), null);
    if (!data) return res.status(404).json({ error: 'could not parse session' });
    res.json({ sessionId: req.params.sessionId, ...data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:sessionId/user-image/:msgUuid/:blockIndex', (req, res) => {
  const metadata = loadSessionMetadata();
  const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).end();
  const img = readUserImage(jsonlPath, req.params.msgUuid, req.params.blockIndex);
  if (!img) return res.status(404).end();
  const buf = Buffer.from(img.data, 'base64');
  res.setHeader('Content-Type', img.mediaType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
});

app.get('/api/sessions/:sessionId/tool-result-image/:toolUseId/:n', (req, res) => {
  const metadata = loadSessionMetadata();
  const meta = metadata[req.params.sessionId] || metadata[resolveSessionId(req.params.sessionId)];
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.status(404).end();
  const img = readToolResultImage(jsonlPath, req.params.toolUseId, req.params.n);
  if (!img) return res.status(404).end();
  const buf = Buffer.from(img.data, 'base64');
  res.setHeader('Content-Type', img.mediaType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(buf);
});

app.get('/api/sessions/:sessionId/cached-image/:n', (req, res) => {
  const img = readCachedImage(req.params.sessionId, req.params.n, CLAUDE_DIR);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mediaType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(img.buffer);
});

// #endregion

// #region META_ROUTES
app.get('/api/version', (_req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version });
});

app.get('/api/config', (_req, res) => {
  res.json({
    marketplaceUrl: MARKETPLACE_URL,
    costUrl: COST_URL,
    memoryUrl: MEMORY_URL,
    scratchAvailable: !!whichSync('scratch'),
  });
});

// #endregion

// #region TASK_ROUTES
// API: Get all tasks across all sessions
app.get('/api/tasks/all', async (_req, res) => {
  try {
    if (!existsSync(TASKS_DIR)) {
      return res.json([]);
    }

    const metadata = loadSessionMetadata();
    const { listToSessions } = loadAllTaskMaps();
    const sessionDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const allTasks = [];

    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(TASKS_DIR, sessionDir.name);
      const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
      const meta = metadata[sessionDir.name] || {};

      // For custom task list directories (non-UUID dirs), resolve project from the
      // mapped sessions since those dirs don't have their own metadata entry.
      let project = meta.project || null;
      if (!project) {
        const mappedSessions = listToSessions[sessionDir.name];
        if (mappedSessions) {
          for (const [sid, info] of Object.entries(mappedSessions)) {
            project = metadata[sid]?.project || info.project || null;
            if (project) break;
          }
        }
      }

      for (const file of taskFiles) {
        try {
          const task = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
          allTasks.push({
            ...task,
            sessionId: sessionDir.name,
            sessionName: getSessionDisplayName(sessionDir.name, meta),
            project
          });
        } catch {
          // Skip invalid files
        }
      }
    }

    res.json(allTasks);
  } catch (error) {
    console.error('Error getting all tasks:', error);
    res.status(500).json({ error: 'Failed to get all tasks' });
  }
});

const { enqueueSessionEvent, formatTaskMoved, handleSessionEvents } = require('./lib/session-events');
app.get('/api/sessions/:sessionId/events', handleSessionEvents);

// API: Create a task
app.post('/api/tasks/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const subject = (req.body.subject || '').trim();
    if (!subject) return res.status(400).json({ error: 'Subject is required' });

    const sessionDir = taskDirFor(sessionId);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

    // Ids are the agent's own numbering scheme, so a hand-made task has to keep counting
    // from the highest one on disk -- reusing a number would overwrite that task's file.
    const ids = readdirSync(sessionDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => parseInt(path.basename(f, '.json'), 10))
      .filter((n) => Number.isInteger(n));
    const id = String(Math.max(0, ...ids) + 1);

    const task = {
      id,
      subject,
      description: (req.body.description || '').trim(),
      activeForm: subject,
      status: 'pending',
      blocks: [],
      blockedBy: [],
    };

    // No doorbell here, unlike a move: the user typed this task, so telling their session
    // about it would only repeat what they just said. Dragging it to In Progress rings.
    await fs.writeFile(path.join(sessionDir, `${id}.json`), JSON.stringify(task, null, 2));
    res.json({ success: true, task });
  } catch (error) {
    console.error('Error creating task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// API: Update task fields (subject, description)
app.put('/api/tasks/:sessionId/:taskId', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const { subject, description } = req.body;

    const sessionDir = taskDirFor(sessionId);
    const taskPath = path.join(sessionDir, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));
    const prevStatus = task.status;

    if (subject !== undefined) task.subject = subject;
    if (description !== undefined) task.description = description;
    if (req.body.status !== undefined) task.status = req.body.status;

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    // Ring the session only for a move. The direction has to ride in the line because
    // the write above destroyed the old status -- nothing downstream can recover it, and
    // which way a task moved is what decides whether to start work or stop it.
    if (task.status !== prevStatus) {
      // The route param is a task *directory*, which for a shared list or team board is
      // not a session id -- and the postman polls with its own session id, so an unresolved
      // name would queue the line where nobody drains it.
      const line = formatTaskMoved(taskId, prevStatus, task);
      for (const sid of resolveSessionsForTaskDir(sessionId)) enqueueSessionEvent(sid, line);
    }

    res.json({ success: true, task });
  } catch (error) {
    console.error('Error updating task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// API: Delete a task
app.delete('/api/tasks/:sessionId/:taskId', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const sessionPath = taskDirFor(sessionId);
    const taskPath = path.join(sessionPath, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // A deleted task can't block anything, so drop the dangling reference instead of
    // refusing the delete -- a stale blockedBy id would pin the other task as BLOCKED forever.
    const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));

    for (const file of taskFiles) {
      const otherPath = path.join(sessionPath, file);
      const otherTask = JSON.parse(readFileSync(otherPath, 'utf8'));
      if (otherTask.blockedBy?.includes(taskId)) {
        otherTask.blockedBy = otherTask.blockedBy.filter(id => id !== taskId);
        await fs.writeFile(otherPath, JSON.stringify(otherTask, null, 2));
      }
    }

    // Delete the task file
    await fs.unlink(taskPath);

    res.json({ success: true, taskId });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// #endregion

// #region PREVIEW
// API: File preview — read file and broadcast to clients
const PREVIEW_KINDS = { '.md': 'markdown', '.markdown': 'markdown', '.html': 'html', '.htm': 'html' };
// Whole files are pushed into a modal, so anything huge freezes the tab regardless of kind.
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

function previewError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Existence + kind of a file target, with the HTTP status codes both the preview and
// the link-a-file endpoints report. `kind` is null for anything the previewer can't
// render — the caller decides whether that disqualifies the path.
async function statFileTarget(absPath) {
  try {
    const stats = await fs.stat(absPath);
    if (!stats.isFile()) throw previewError(400, 'Not a file');
    return { size: stats.size, kind: PREVIEW_KINDS[path.extname(absPath).toLowerCase()] || null };
  } catch (e) {
    if (e.status) throw e;
    if (e.code === 'ENOENT') throw previewError(404, 'File not found');
    if (e.code === 'EISDIR') throw previewError(400, 'Not a file');
    throw e;
  }
}

// Checks the file is previewable without reading it — the broadcast path needs the
// validation (and its status codes) but never the content.
async function validatePreviewFile(absPath) {
  const { kind, size } = await statFileTarget(absPath);
  if (!kind) throw previewError(400, 'Only .md/.markdown/.html/.htm files are allowed');
  if (size > PREVIEW_MAX_BYTES) {
    throw previewError(
      400,
      `Preview too large (${Math.round(size / 1048576)}MB, max ${PREVIEW_MAX_BYTES / 1048576}MB)`
    );
  }
  return { kind, size };
}

async function readPreviewFile(absPath) {
  const { kind } = await validatePreviewFile(absPath);
  const raw = await fs.readFile(absPath, 'utf8');
  if (kind !== 'html') return { content: raw, kind };
  // The client renders HTML into a `srcdoc` iframe, which has no base URL — sibling
  // assets have to travel inside the document or they never load.
  try {
    const { html, skipped } = await inlineHtmlAssets(raw, absPath);
    for (const s of skipped) {
      console.warn(`Preview: skipped inlining ${s.path} (${s.reason}, ${s.size} bytes)`);
    }
    return { content: html, kind };
  } catch (e) {
    // Inlining is an enhancement: a failure here must not cost the user the preview.
    console.error('Preview: asset inlining failed, serving as authored:', e.message);
    return { content: raw, kind };
  }
}

// Paths copied out of a browser or a slide deck carry a URL fragment
// ("deck.html#10"). Dropped only when the literal path is missing and the trimmed one
// exists, so a filename that genuinely contains '#' still resolves to itself.
function dropUrlFragment(abs) {
  const i = abs.lastIndexOf('#');
  if (i <= 0 || existsSync(abs)) return abs;
  const trimmed = abs.slice(0, i);
  return existsSync(trimmed) ? trimmed : abs;
}

function resolvePreviewPath(rawPath, base) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  // Every path entering the preview/link surface passes through here, so accepting
  // `file://` once covers /api/preview, /api/document/link and /api/file/resolve.
  const filePath = fileUrlToPath(rawPath);
  if (path.isAbsolute(filePath)) return dropUrlFragment(filePath);
  if (base && typeof base === 'string' && path.isAbsolute(base)) {
    let baseDir = base;
    try {
      if (statSync(base).isFile()) baseDir = path.dirname(base);
    } catch {
      // base doesn't exist — fall back to dirname if it looks like a file
      if (path.extname(base)) baseDir = path.dirname(base);
    }
    return dropUrlFragment(path.resolve(baseDir, filePath));
  }
  return dropUrlFragment(path.resolve(filePath));
}

app.post('/api/preview', async (req, res) => {
  try {
    const { path: filePath, sessionId, base } = req.body || {};
    const abs = resolvePreviewPath(filePath, base);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    // Validate here so the CLI still gets 400/404, but broadcast the path only —
    // each tab fetches the document itself instead of it being fanned out over SSE.
    await validatePreviewFile(abs);
    broadcast({ type: 'preview:open', path: abs, sessionId: sessionId || null });
    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/preview:', error);
    res.status(error.status || 500).json({ error: error.message || 'Preview failed' });
  }
});

// API: Link a file to a session's sidebar docs without opening the preview modal.
// Not extension-restricted, matching /api/file/resolve — an unpreviewable link just
// opens in the editor. Unlinking skips the stat so a deleted file can still be removed.
app.post('/api/document/link', async (req, res) => {
  try {
    const { path: filePath, sessionId, unlink } = req.body || {};
    if (typeof sessionId !== 'string' || !sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const abs = resolvePreviewPath(filePath);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    if (!unlink) await statFileTarget(abs);
    broadcast({ type: 'document:link', path: abs, sessionId, unlink: !!unlink });
    res.json({ success: true });
  } catch (error) {
    console.error('Error in /api/document/link:', error);
    res.status(error.status || 500).json({ error: error.message || 'Link failed' });
  }
});

app.get('/api/session/resolve', (req, res) => {
  try {
    const idArg = (req.query.id || '').toString();
    if (!idArg) return res.status(400).json({ error: 'id is required' });
    const metadata = loadSessionMetadata();
    const ids = Object.keys(metadata);
    if (Object.hasOwn(metadata, idArg)) {
      const m = metadata[idArg];
      return res.json({ id: idArg, customTitle: m?.customTitle || null });
    }
    const matches = ids.filter(id => id.startsWith(idArg));
    if (matches.length === 0) return res.status(404).json({ matches: [] });
    if (matches.length > 1) {
      return res.status(409).json({
        matches: matches.slice(0, 50).map(id => ({ id, customTitle: metadata[id]?.customTitle || null }))
      });
    }
    const id = matches[0];
    res.json({ id, customTitle: metadata[id]?.customTitle || null });
  } catch (error) {
    console.error('Error in /api/session/resolve:', error);
    res.status(500).json({ error: error.message || 'Failed' });
  }
});

app.post('/api/session/open', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
    broadcast({ type: 'session:open', id });
    res.json({ success: true, id });
  } catch (error) {
    console.error('Error in /api/session/open:', error);
    res.status(500).json({ error: error.message || 'Failed' });
  }
});

app.post('/api/session/pin', async (req, res) => {
  try {
    const { id, state } = req.body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' });
    if (!['none', 'pinned', 'sticky'].includes(state)) {
      return res.status(400).json({ error: 'state must be none|pinned|sticky' });
    }
    const pins = readPins();
    if (state === 'none') delete pins[id];
    else pins[id] = state;
    writePins(pins);
    broadcast({ type: 'session:pin', id, state });
    res.json({ success: true, id, state });
  } catch (error) {
    console.error('Error in /api/session/pin:', error);
    res.status(500).json({ error: error.message || 'Failed' });
  }
});

app.get('/api/session/pins', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const pins = readPins();
    const items = Object.entries(pins).map(([id, state]) => ({ id, state }));
    res.json({ pins, items });
  } catch (error) {
    console.error('Error in GET /api/session/pins:', error);
    res.status(500).json({ error: error.message || 'Failed' });
  }
});

app.get('/api/preview', async (req, res) => {
  try {
    const abs = resolvePreviewPath(req.query.path, req.query.base);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    const { content, kind } = await readPreviewFile(abs);
    res.json({ path: abs, content, kind });
  } catch (error) {
    console.error('Error in GET /api/preview:', error);
    res.status(error.status || 500).json({ error: error.message || 'Preview failed' });
  }
});

// API: Resolve a hand-typed path to an absolute one that exists. Deliberately not
// extension-restricted — a linked file the previewer can't render (kind: null) is
// still linkable, the client just opens it in the editor instead.
app.get('/api/file/resolve', async (req, res) => {
  try {
    const abs = resolvePreviewPath(req.query.path, req.query.base);
    if (!abs) return res.status(400).json({ error: 'path is required' });
    // No size cap here — an unpreviewable file of any size is still linkable.
    res.json({ path: abs, ...(await statFileTarget(abs)) });
  } catch (error) {
    console.error('Error in GET /api/file/resolve:', error);
    res.status(error.status || 500).json({ error: error.message || 'Failed to resolve file' });
  }
});

// #endregion

// #region SSE
// SSE endpoint for live updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  clients.add(res);
  console.log(`[SSE] Client connected (total: ${clients.size})`);

  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[SSE] Client disconnected (total: ${clients.size})`);
  });

  // Send initial ping
  res.write('data: {"type":"connected"}\n\n');
});

// Broadcast update to all SSE clients
function broadcast(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(message);
  }
}

app.get('/api/context-status', (_req, res) => {
  res.json(Object.fromEntries(contextStatusCache));
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Watch for file changes (chokidar handles non-existent paths)
const watcher = chokidar.watch(TASKS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2
});

watcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    const relativePath = path.relative(TASKS_DIR, filePath);
    const dirName = relativePath.split(path.sep)[0];

    taskCountsCache.delete(path.join(TASKS_DIR, dirName));

    broadcastToMappedSessions(dirName, event, filePath);
  }
});

// Which sessions own a task directory. Usually the dir name IS the session id, but a
// shared list or a team dir is one directory several sessions map onto -- so anything
// addressing a session from a task path has to fan out the same way. One resolver for
// both readers of that mapping: the SSE broadcast and the doorbell.
// #endregion

// #region DOORBELL
function resolveSessionsForTaskDir(name) {
  if (isUUID(name)) return [name];
  const { listToSessions } = loadAllTaskMaps();
  const map = listToSessions[name];
  if (map) return Object.keys(map);
  // Fallback: check if name is a team name
  const cfg = loadTeamConfig(name);
  return cfg?.leadSessionId ? [cfg.leadSessionId] : [];
}

function broadcastToMappedSessions(taskListName, event, filePath) {
  for (const sid of resolveSessionsForTaskDir(taskListName)) {
    broadcast({ type: 'update', event, sessionId: sid, file: path.basename(filePath) });
  }
}

console.log(`Watching for changes in: ${TASKS_DIR}`);

// Watch task maps directory for session→task-list mapping changes
const taskMapsWatcher = chokidar.watch(TASK_MAPS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 1
});
taskMapsWatcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    lastTaskMapScan = 0;
    const taskListName = path.basename(filePath, '.json');
    taskCountsCache.delete(path.join(TASKS_DIR, taskListName));
    broadcastToMappedSessions(taskListName, event, filePath);
  }
});

// Watch teams directory for config changes
const teamsWatcher = chokidar.watch(TEAMS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 3
});

teamsWatcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    const relativePath = path.relative(TEAMS_DIR, filePath);
    const teamName = relativePath.split(path.sep)[0];
    teamConfigCache.delete(teamName);
    broadcast({ type: 'team-update', teamName });
  }
});

console.log(`Watching for team changes in: ${TEAMS_DIR}`);

// Also watch projects dir for metadata changes
const projectsWatcher = chokidar.watch(PROJECTS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2,
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
});

projectsWatcher.on('all', (event, filePath) => {
  if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
  if (filePath.endsWith('.jsonl')) {
    if (event === 'unlink') {
      loopInfoStateByPath.delete(filePath);
    } else {
      // Warm the incremental scan state so the next request does no IO.
      try { refreshLoopInfoState(filePath); } catch (_) {}
    }
    // add/unlink reshape the session set — promote to full rescan.
    if (event === 'change') dirtyMetadataPaths.add(filePath);
    else metadataNeedsFullScan = true;
    broadcast({ type: 'metadata-update' });
  } else if (path.basename(filePath) === 'sessions-index.json') {
    // Index holds description / created / customTitle that the targeted
    // refresh doesn't touch — promote to full rescan.
    metadataNeedsFullScan = true;
    broadcast({ type: 'metadata-update' });
  }
});

const plansWatcher = chokidar.watch(PLANS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 0
});

plansWatcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.md')) {
    // Plan files don't affect cached session metadata — getPlanInfo is called
    // fresh from buildSessionObject on every list build. The broadcast alone
    // is enough to trigger a client refetch.
    broadcast({ type: 'metadata-update' });
    if (event === 'change') {
      const slug = path.basename(filePath, '.md');
      broadcast({ type: 'plan-update', slug });
    }
  }
});

// Watch agent-activity directory for subagent lifecycle events
const agentActivityWatcher = chokidar.watch(AGENT_ACTIVITY_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2,
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
});

const AGENT_FILE_CAP = 20;

agentActivityWatcher.on('all', (event, filePath) => {
  const base = path.basename(filePath);
  const isAgentEvent = filePath.endsWith('.jsonl') || base === '_waiting.json';
  if ((event === 'add' || event === 'change' || event === 'unlink') && isAgentEvent) {
    const relativePath = path.relative(AGENT_ACTIVITY_DIR, filePath);
    const sessionId = relativePath.split(path.sep)[0];
    // Cleanup: if session dir exceeds cap, delete oldest files by mtime
    if (event === 'add' && filePath.endsWith('.jsonl')) {
      try {
        const sessionDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
        const files = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('_'));
        if (files.length > AGENT_FILE_CAP) {
          const withStats = files.map(f => {
            const fp = path.join(sessionDir, f);
            return { file: fp, mtime: statSync(fp).mtimeMs };
          }).sort((a, b) => a.mtime - b.mtime);
          const toDelete = withStats.slice(0, files.length - AGENT_FILE_CAP);
          for (const { file } of toDelete) {
            fs.unlink(file).catch(() => {});
          }
        }
      } catch { /* ignore */ }
    }
    broadcast({ type: 'agent-update', sessionId });
    // For team sessions, also broadcast with team name so frontend picks it up
    if (existsSync(TEAMS_DIR)) {
      try {
        const teamDirs = readdirSync(TEAMS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const td of teamDirs) {
          const cfg = loadTeamConfig(td.name);
          if (cfg && cfg.leadSessionId === sessionId) {
            broadcast({ type: 'agent-update', sessionId: td.name });
            break;
          }
        }
      } catch { /* ignore */ }
    }
  }
});

// Watch context-status directory for statusline updates
const contextStatusWatcher = chokidar.watch(CONTEXT_STATUS_DIR, {
  persistent: true,
  ignoreInitial: false,
  depth: 0
});

contextStatusWatcher.on('all', (event, filePath) => {
  if (!filePath.endsWith('.json')) return;
  const sessionId = path.basename(filePath, '.json');
  if (event === 'add' || event === 'change') {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      try { data._updatedAt = statSync(filePath).mtimeMs; } catch (_) { data._updatedAt = Date.now(); }
      contextStatusCache.set(sessionId, data);
      evictStaleCache(contextStatusCache);
    } catch { /* ignore malformed */ }
    broadcast({ type: 'context-update', sessionId });
  } else if (event === 'unlink') {
    contextStatusCache.delete(sessionId);
    broadcast({ type: 'context-update', sessionId });
  }
});

// #endregion

// #region CLEANUP
async function cleanupContextStatus() {
  try {
    const entries = await fs.readdir(CONTEXT_STATUS_DIR);
    const now = Date.now();
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const fp = path.join(CONTEXT_STATUS_DIR, f);
        const st = statSync(fp);
        if (now - st.mtimeMs > CTX_CLEANUP_MAX_AGE_MS) {
          await fs.unlink(fp);
          contextStatusCache.delete(path.basename(f, '.json'));
        }
      } catch { /* ignore */ }
    }
  } catch { /* dir may not exist */ }
}

async function cleanupAgentActivity() {
  try {
    const entries = await fs.readdir(AGENT_ACTIVITY_DIR, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const dirPath = path.join(AGENT_ACTIVITY_DIR, entry.name);
        const contents = await fs.readdir(dirPath);
        const stat = await fs.stat(dirPath);
        const age = now - stat.mtimeMs;
        if ((contents.length === 0 && age > AGENT_STALE_MS) || age > CLEANUP_MAX_AGE_MS) {
          await fs.rm(dirPath, { recursive: true, force: true });
          continue;
        }
        // Orphaned decision files: a terminal deny fires no hook event (D13), so a
        // board answer for an already-gone gate is never consumed. The gate waits at
        // most PERMISSION_TTL_MS, so anything older is unclaimable.
        for (const f of contents) {
          if (!isDecisionFile(f)) continue;
          const fp = path.join(dirPath, f);
          try {
            const fst = await fs.stat(fp);
            if (now - fst.mtimeMs > PERMISSION_TTL_MS) await fs.rm(fp, { force: true });
          } catch { /* ignore per-file errors */ }
        }
      } catch { /* ignore per-folder errors */ }
    }
  } catch { /* agent-activity dir may not exist */ }
}

cleanupAgentActivity();
cleanupContextStatus();
setInterval(cleanupAgentActivity, CLEANUP_INTERVAL_MS);
setInterval(cleanupContextStatus, 30 * 60 * 1000);

// Warm the metadata + loop-info caches in the background so the first user
// request lands warm. The cheap-probe in /api/sessions skips per-session
// enrichment for inactive sessions, so we no longer drive a full self-request
// here — that was 690× wasted work for an active-filter first hit.
// Yields to the event loop periodically so any inbound request isn't starved.
async function prewarmCaches() {
  const t0 = Date.now();
  try {
    const metadata = loadSessionMetadata();

    let i = 0;
    for (const meta of Object.values(metadata)) {
      if (meta?.jsonlPath) {
        try { refreshLoopInfoState(meta.jsonlPath); } catch {}
      }
      if (++i % 50 === 0) await new Promise(r => setImmediate(r));
    }

    console.log(`[prewarm] done in ${Date.now() - t0}ms (${Object.keys(metadata).length} sessions)`);
  } catch (e) {
    console.warn('[prewarm] failed:', e.message);
  }
}

  const onReady = (actualPort) => {
    console.log(`Claude Task Kanban running at http://localhost:${actualPort}`);
    // The port is configurable and falls back to a random one when taken, so the postman
    // monitor cannot assume it -- publish the live one where it can read it.
    writeServerInfo(actualPort);
    const warning = net.exposureWarning();
    if (warning) console.log(warning);

    if (process.argv.includes('--open')) {
      import('open').then(open => open.default(`http://localhost:${actualPort}`));
    }
    setImmediate(prewarmCaches);
  };

  const server = net.listenLoopback(app, PORT, onReady);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} in use, trying random port...`);
      net.listenLoopback(app, 0, onReady);
    } else {
      throw err;
    }
  });


// #endregion