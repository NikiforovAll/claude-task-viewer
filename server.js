#!/usr/bin/env node

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { existsSync, readdirSync, readFileSync, writeFileSync, statSync, createReadStream, unlinkSync } = require('fs');
const readline = require('readline');
const chokidar = require('chokidar');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
  readRecentMessages: _readRecentMessagesUncached,
  readSessionInfoFromJsonl,
  buildAgentProgressMap,
  readCompactSummaries
} = require('./lib/parsers');

const isSetupCommand = process.argv.includes('--install') || process.argv.includes('--uninstall');

if (isSetupCommand) {
  const { runInstall, runUninstall } = require('./install');
  (process.argv.includes('--install') ? runInstall() : runUninstall())
    .then(() => process.exit(0))
    .catch(e => { console.error(e.message); process.exit(1); });
}

const app = express();
const PORT = process.env.PORT || 3456;

// Parse --dir flag for custom Claude directory
function getClaudeDir() {
  const dirIndex = process.argv.findIndex(arg => arg.startsWith('--dir'));
  if (dirIndex !== -1) {
    const arg = process.argv[dirIndex];
    if (arg.includes('=')) {
      const dir = arg.split('=')[1];
      return dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir;
    } else if (process.argv[dirIndex + 1]) {
      const dir = process.argv[dirIndex + 1];
      return dir.startsWith('~') ? dir.replace('~', os.homedir()) : dir;
    }
  }
  return process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
}

const CLAUDE_DIR = getClaudeDir();
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const PLANS_DIR = path.join(CLAUDE_DIR, 'plans');
const AGENT_ACTIVITY_DIR = path.join(CLAUDE_DIR, 'agent-activity');
const CONTEXT_STATUS_DIR = path.join(CLAUDE_DIR, 'context-status');

const PERMISSION_TTL_MS = 1800000;
const AGENT_TTL_MS = 3600000;
const AGENT_STALE_MS = 300000;

const WAITING_RESOLVE_GRACE_MS = 15000;

function checkWaitingForUser(agentDir, logMtime) {
  try {
    const data = JSON.parse(readFileSync(path.join(agentDir, '_waiting.json'), 'utf8'));
    if (data.status === 'waiting' && data.timestamp) {
      const waitTime = new Date(data.timestamp).getTime();
      const age = Date.now() - waitTime;
      if (age >= PERMISSION_TTL_MS) return null;
      // After grace period, check if session resumed activity (user already responded)
      if (logMtime && age >= WAITING_RESOLVE_GRACE_MS && logMtime > waitTime + WAITING_RESOLVE_GRACE_MS) return null;
      return data;
    }
  } catch (e) { /* skip — missing or invalid */ }
  return null;
}

function isAgentFresh(agent) {
  if (!agent.updatedAt) return true;
  return (Date.now() - new Date(agent.updatedAt).getTime()) < AGENT_TTL_MS;
}

function getSessionLogStat(meta) {
  if (!meta.jsonlPath) return { mtime: null, hasMessages: false };
  try {
    const st = statSync(meta.jsonlPath);
    return { mtime: st.mtimeMs, hasMessages: st.size > 1000 };
  } catch (e) { return { mtime: null, hasMessages: false }; }
}

function checkAgentStatus(agentDir, stale, logMtime) {
  const result = { hasActive: false, hasRunning: false, waitingForUser: null };
  if (!existsSync(agentDir)) return result;
  result.waitingForUser = checkWaitingForUser(agentDir, logMtime);
  if (result.waitingForUser) result.hasActive = true;
  if (stale) return result;
  try {
    for (const file of readdirSync(agentDir).filter(f => f.endsWith('.json') && !f.startsWith('_'))) {
      try {
        const agent = JSON.parse(readFileSync(path.join(agentDir, file), 'utf8'));
        if (isAgentFresh(agent)) {
          if (agent.status === 'active') { result.hasActive = true; result.hasRunning = true; }
          else if (agent.status === 'idle') { result.hasActive = true; }
        }
        if (result.hasRunning && result.hasActive) break;
      } catch (e) { /* skip invalid */ }
    }
  } catch (e) { /* ignore */ }
  return result;
}

function isTeamSession(sessionId) {
  return existsSync(path.join(TEAMS_DIR, sessionId, 'config.json'));
}

const teamConfigCache = new Map();
const TEAM_CACHE_TTL = 5000;

function loadTeamConfig(teamName) {
  const cached = teamConfigCache.get(teamName);
  if (cached && Date.now() - cached.ts < TEAM_CACHE_TTL) return cached.data;
  try {
    const configPath = path.join(TEAMS_DIR, teamName, 'config.json');
    if (!existsSync(configPath)) return null;
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    teamConfigCache.set(teamName, { data, ts: Date.now() });
    return data;
  } catch (e) {
    return null;
  }
}

function resolveSessionId(sessionId) {
  const teamConfig = loadTeamConfig(sessionId);
  return (teamConfig && teamConfig.leadSessionId) ? teamConfig.leadSessionId : sessionId;
}

// SSE clients for live updates
const clients = new Set();

// Cache for session metadata (refreshed periodically)
let sessionMetadataCache = {};
let lastMetadataRefresh = 0;
const METADATA_CACHE_TTL = 10000; // 10 seconds

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id);
}

app.param('sessionId', (req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid session ID' });
  next();
});
app.param('taskId', (req, res, next, val) => {
  if (!isSafeId(val)) return res.status(400).json({ error: 'Invalid task ID' });
  next();
});

// Parse JSON bodies
app.use(express.json());

// Serve static files
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));

const messageCache = new Map();
const MESSAGE_CACHE_TTL = 5000;
const MAX_CACHE_ENTRIES = 200;
const progressMapCache = new Map();
const compactSummaryCache = new Map();
const taskCountsCache = new Map();
const contextStatusCache = new Map();

function evictStaleCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = cache.keys().next().value;
  if (oldest !== undefined) cache.delete(oldest);
}

function getTaskCounts(sessionPath) {
  const cached = taskCountsCache.get(sessionPath);
  if (cached) return cached;

  const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
  let completed = 0, inProgress = 0, pending = 0, newestTaskMtime = null;

  for (const file of taskFiles) {
    try {
      const taskPath = path.join(sessionPath, file);
      const task = JSON.parse(readFileSync(taskPath, 'utf8'));
      if (task.metadata && task.metadata._internal) continue;
      if (task.status === 'completed') completed++;
      else if (task.status === 'in_progress') inProgress++;
      else pending++;
      const taskStat = statSync(taskPath);
      if (!newestTaskMtime || taskStat.mtime > newestTaskMtime) {
        newestTaskMtime = taskStat.mtime;
      }
    } catch (e) { /* skip invalid */ }
  }

  const result = { taskCount: taskFiles.length, completed, inProgress, pending, newestTaskMtime };
  taskCountsCache.set(sessionPath, result);
  return result;
}

function getProgressMap(jsonlPath) {
  try {
    const cached = progressMapCache.get(jsonlPath);
    if (cached && Date.now() - cached.ts < MESSAGE_CACHE_TTL) return cached.map;
    const st = statSync(jsonlPath);
    if (cached && cached.mtime === st.mtimeMs) {
      cached.ts = Date.now();
      return cached.map;
    }
    const map = buildAgentProgressMap(jsonlPath);
    progressMapCache.set(jsonlPath, { map, mtime: st.mtimeMs, ts: Date.now() });
    evictStaleCache(progressMapCache);
    return map;
  } catch (_) { return {}; }
}

function readRecentMessages(jsonlPath, limit = 10) {
  try {
    const stat = statSync(jsonlPath);
    const cached = messageCache.get(jsonlPath);
    if (cached && cached.mtime === stat.mtimeMs && Date.now() - cached.ts < MESSAGE_CACHE_TTL) {
      return cached.messages;
    }
    const messages = _readRecentMessagesUncached(jsonlPath, limit);
    messageCache.set(jsonlPath, { messages, mtime: stat.mtimeMs, ts: Date.now() });
    evictStaleCache(messageCache);
    return messages;
  } catch (e) {
    return [];
  }
}

/**
 * Scan all project directories to find session JSONL files and extract slugs
 */
function loadSessionMetadata() {
  const now = Date.now();
  if (now - lastMetadataRefresh < METADATA_CACHE_TTL) {
    return sessionMetadataCache;
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

      // First pass: read all JSONL files
      let resolvedProjectPath = null;
      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const jsonlPath = path.join(projectPath, file);
        const sessionInfo = readSessionInfoFromJsonl(jsonlPath);

        if (sessionInfo.projectPath && !resolvedProjectPath) {
          resolvedProjectPath = sessionInfo.projectPath;
        }

        metadata[sessionId] = {
          slug: sessionInfo.slug,
          project: sessionInfo.projectPath || null,
          gitBranch: sessionInfo.gitBranch || null,
          customTitle: sessionInfo.customTitle || null,
          jsonlPath: jsonlPath
        };
        sessionIds.push(sessionId);
      }

      // Second pass: fill in missing project paths from siblings
      if (resolvedProjectPath) {
        for (const sid of sessionIds) {
          if (!metadata[sid].project) {
            metadata[sid].project = resolvedProjectPath;
          }
        }
      }

      // Also check sessions-index.json for custom names (if /rename was used)
      const indexPath = path.join(projectPath, 'sessions-index.json');
      if (existsSync(indexPath)) {
        try {
          const indexData = JSON.parse(readFileSync(indexPath, 'utf8'));
          const entries = indexData.entries || [];

          for (const entry of entries) {
            if (entry.sessionId) {
              if (!metadata[entry.sessionId]) {
                metadata[entry.sessionId] = {
                  slug: null,
                  project: entry.projectPath || null,
                  jsonlPath: null
                };
              }
              metadata[entry.sessionId].description = entry.description || null;
              if (entry.gitBranch) metadata[entry.sessionId].gitBranch = entry.gitBranch;
              if (entry.customTitle) metadata[entry.sessionId].customTitle = entry.customTitle;
              metadata[entry.sessionId].created = entry.created || null;
            }
          }
        } catch (e) {
          // Skip invalid index files
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
  return metadata;
}

function getPlanInfo(slug) {
  if (!slug) return { hasPlan: false, planTitle: null, planPath: null };
  const planPath = path.join(PLANS_DIR, `${slug}.md`);
  if (!existsSync(planPath)) return { hasPlan: false, planTitle: null, planPath: null };
  try {
    const head = readFileSync(planPath, 'utf8').slice(0, 512);
    const match = head.match(/^#\s+(.+)$/m);
    return { hasPlan: true, planTitle: match ? match[1].trim() : null, planPath };
  } catch (e) {
    return { hasPlan: true, planTitle: null, planPath };
  }
}

function getSessionDisplayName(sessionId, meta) {
  if (meta?.customTitle) return meta.customTitle;
  if (meta?.slug) return meta.slug;
  return null;
}

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

    const metadata = loadSessionMetadata();
    const sessionsMap = new Map();

    // First, add sessions that have tasks directories
    if (existsSync(TASKS_DIR)) {
      const entries = readdirSync(TASKS_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionPath = path.join(TASKS_DIR, entry.name);
          const stat = statSync(sessionPath);
          const { taskCount, completed, inProgress, pending, newestTaskMtime } = getTaskCounts(sessionPath);

          // Get metadata for this session
          const meta = metadata[entry.name] || {};

          const logStat = getSessionLogStat(meta);
          const logMtime = logStat.mtime;
          const logAge = logMtime ? Date.now() - logMtime : Infinity;
          const stale = logAge > AGENT_STALE_MS;

          // Use newest of: task file mtime, JSONL mtime, directory mtime
          let modifiedAt = newestTaskMtime ? newestTaskMtime.toISOString() : stat.mtime.toISOString();
          if (logMtime) {
            const jsonlMtime = new Date(logMtime).toISOString();
            if (jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
          }

          const isTeam = isTeamSession(entry.name);
          const memberCount = isTeam ? (loadTeamConfig(entry.name)?.members?.length || 0) : 0;
          const planInfo = getPlanInfo(meta.slug);

          const resolvedAgentDir = (() => {
            const tc = loadTeamConfig(entry.name);
            const rid = (tc && tc.leadSessionId) ? tc.leadSessionId : entry.name;
            return path.join(AGENT_ACTIVITY_DIR, rid);
          })();
          const agentStatus = checkAgentStatus(resolvedAgentDir, stale, logMtime);

          sessionsMap.set(entry.name, {
            id: entry.name,
            name: getSessionDisplayName(entry.name, meta),
            slug: meta.slug || null,
            project: meta.project || null,
            description: meta.description || null,
            gitBranch: meta.gitBranch || null,
            customTitle: meta.customTitle || null,
            taskCount,
            completed,
            inProgress,
            pending,
            createdAt: meta.created || null,
            modifiedAt: modifiedAt,
            isTeam,
            memberCount,
            hasMessages: logStat.hasMessages,
            hasActiveAgents: agentStatus.hasActive,
            hasRunningAgents: agentStatus.hasRunning,
            hasWaitingForUser: !!agentStatus.waitingForUser,
            hasRecentLog: logAge <= AGENT_STALE_MS,
            jsonlPath: meta.jsonlPath || null,
            tasksDir: sessionPath,
            projectDir: meta.jsonlPath ? path.dirname(meta.jsonlPath) : null,
            contextStatus: (logAge <= AGENT_STALE_MS || agentStatus.hasActive || inProgress > 0 || pinnedIds.has(entry.name)) ? (contextStatusCache.get(entry.name) || null) : null,
            ...planInfo
          });
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
        let modifiedAt = meta.created || null;
        if (logMtime) {
          const jsonlMtime = new Date(logMtime).toISOString();
          if (!modifiedAt || jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
        }
        const planInfo = getPlanInfo(meta.slug);
        const metaAgentDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
        const metaAgentStatus = checkAgentStatus(metaAgentDir, stale, logMtime);
        sessionsMap.set(sessionId, {
          id: sessionId,
          name: getSessionDisplayName(sessionId, meta),
          slug: meta.slug || null,
          project: meta.project || null,
          description: meta.description || null,
          gitBranch: meta.gitBranch || null,
          customTitle: meta.customTitle || null,
          taskCount: 0,
          completed: 0,
          inProgress: 0,
          pending: 0,
          createdAt: meta.created || null,
          modifiedAt: modifiedAt || new Date(0).toISOString(),
          isTeam: false,
          memberCount: 0,
          hasMessages: logStat.hasMessages,
          hasActiveAgents: metaAgentStatus.hasActive,
          hasRunningAgents: metaAgentStatus.hasRunning,
          hasWaitingForUser: !!metaAgentStatus.waitingForUser,
          hasRecentLog: logAge <= AGENT_STALE_MS,
          jsonlPath: meta.jsonlPath || null,
          tasksDir: null,
          projectDir: meta.jsonlPath ? path.dirname(meta.jsonlPath) : null,
          contextStatus: (logAge <= AGENT_STALE_MS || metaAgentStatus.hasActive || pinnedIds.has(sessionId)) ? (contextStatusCache.get(sessionId) || null) : null,
          ...planInfo
        });
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
          sessionsMap.set(dir.name, {
            id: dir.name,
            name: getSessionDisplayName(dir.name, meta),
            slug: meta.slug || null,
            project: meta.project || null,
            description: meta.description || null,
            gitBranch: meta.gitBranch || null,
            customTitle: meta.customTitle || null,
            taskCount: 0,
            completed: 0,
            inProgress: 0,
            pending: 0,
            createdAt: meta.created || null,
            modifiedAt: waiting.timestamp || new Date().toISOString(),
            isTeam: false,
            memberCount: 0,
            hasMessages: logStat.hasMessages,
            hasActiveAgents: true,
            hasWaitingForUser: true,
            jsonlPath: meta.jsonlPath || null,
            tasksDir: null,
            projectDir: meta.jsonlPath ? path.dirname(meta.jsonlPath) : null,
          });
        }
      } catch (e) { /* ignore */ }
    }

    // Hide leader UUID sessions that are represented by a team session
    const teamLeaderIds = new Set();
    for (const [sid, session] of sessionsMap) {
      if (session.isTeam) {
        const cfg = loadTeamConfig(sid);
        if (cfg?.leadSessionId) teamLeaderIds.add(cfg.leadSessionId);
      }
    }
    for (const leaderId of teamLeaderIds) {
      const session = sessionsMap.get(leaderId);
      if (session && session.taskCount === 0) {
        sessionsMap.delete(leaderId);
      }
    }

    // Correlate plan sessions with their implementation sessions (same slug)
    const slugGroups = new Map();
    for (const [sid, session] of sessionsMap) {
      if (session.slug) {
        if (!slugGroups.has(session.slug)) slugGroups.set(session.slug, []);
        slugGroups.get(session.slug).push(session);
      }
    }
    for (const [slug, group] of slugGroups) {
      if (group.length < 2) continue;
      group.sort((a, b) => new Date(a.modifiedAt) - new Date(b.modifiedAt));
      const planSession = group.find(s => s.hasPlan);
      const implSession = group.find(s => s !== planSession && new Date(s.modifiedAt) >= new Date(planSession?.modifiedAt || 0));
      if (planSession && implSession) {
        planSession.hasWaitingForUser = false;
        planSession.planImplementationSessionId = implSession.id;
        implSession.planSourceSessionId = planSession.id;
      }
    }

    // Backfill contextStatus for already-built sessions that are pinned
    for (const pid of pinnedIds) {
      const s = sessionsMap.get(pid);
      if (s && !s.contextStatus) {
        s.contextStatus = contextStatusCache.get(pid) || null;
      }
    }

    // Ensure pinned sessions are in the map even if they weren't discovered
    for (const pid of pinnedIds) {
      if (sessionsMap.has(pid)) continue;
      const meta = metadata[pid];
      if (!meta) continue;
      const logStat = getSessionLogStat(meta);
      const logMtime = logStat.mtime;
      let modifiedAt = meta.created || null;
      if (logMtime) {
        const jsonlMtime = new Date(logMtime).toISOString();
        if (!modifiedAt || jsonlMtime > modifiedAt) modifiedAt = jsonlMtime;
      }
      sessionsMap.set(pid, {
        id: pid,
        name: getSessionDisplayName(pid, meta),
        slug: meta.slug || null,
        project: meta.project || null,
        description: meta.description || null,
        gitBranch: meta.gitBranch || null,
        customTitle: meta.customTitle || null,
        taskCount: 0, completed: 0, inProgress: 0, pending: 0,
        createdAt: meta.created || null,
        modifiedAt: modifiedAt || new Date(0).toISOString(),
        isTeam: false, memberCount: 0,
        hasMessages: logStat.hasMessages,
        hasActiveAgents: false, hasRunningAgents: false, hasWaitingForUser: false,
        hasRecentLog: false,
        jsonlPath: meta.jsonlPath || null,
        tasksDir: null,
        projectDir: meta.jsonlPath ? path.dirname(meta.jsonlPath) : null,
        contextStatus: contextStatusCache.get(pid) || null,
        ...getPlanInfo(meta.slug)
      });
    }

    // Convert map to array and sort by most recently modified
    let sessions = Array.from(sessionsMap.values());
    sessions.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));

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
app.get('/api/projects', (req, res) => {
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
    const sessionPath = path.join(TASKS_DIR, req.params.sessionId);

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
    tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id));

    res.json(tasks);
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// API: Get session plan
app.get('/api/sessions/:sessionId/plan', async (req, res) => {
  try {
    const metadata = loadSessionMetadata();
    const meta = metadata[req.params.sessionId];
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

function openInEditor(...targets) {
  const editor = process.env.EDITOR || 'code';
  spawn(editor, ['-n', ...targets], { shell: true, stdio: 'ignore', detached: true }).unref();
}

// API: Open session plan in VS Code
app.post('/api/sessions/:sessionId/plan/open', (req, res) => {
  try {
    const metadata = loadSessionMetadata();
    const meta = metadata[req.params.sessionId];
    const slug = meta?.slug;
    if (!slug) return res.status(404).json({ error: 'No plan found' });

    const planPath = path.join(PLANS_DIR, `${slug}.md`);
    if (!existsSync(planPath)) return res.status(404).json({ error: 'No plan found' });

    openInEditor(planPath);
    res.json({ success: true });
  } catch (error) {
    console.error('Error opening plan in editor:', error);
    res.status(500).json({ error: 'Failed to open plan' });
  }
});

// API: Open folder (and optionally a file within it) in editor
app.post('/api/open-folder', (req, res) => {
  try {
    const { folder, file } = req.body;
    const target = folder || CLAUDE_DIR;
    openInEditor(target, ...(file ? [file] : []));
    res.json({ success: true });
  } catch (error) {
    console.error('Error opening folder:', error);
    res.status(500).json({ error: 'Failed to open folder' });
  }
});

// API: Open content in editor as temp file
app.post('/api/open-in-editor', (req, res) => {
  try {
    const { content, title } = req.body;
    if (!content) return res.status(400).json({ error: 'No content provided' });

    const safeName = (title || 'message').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const hash = crypto.createHash('md5').update(content).digest('hex').slice(0, 8);
    const tmpFile = path.join(os.tmpdir(), `claude-kanban-${safeName}-${hash}.md`);
    require('fs').writeFileSync(tmpFile, content, 'utf8');

    openInEditor(tmpFile);
    res.json({ success: true, path: tmpFile });
  } catch (error) {
    console.error('Error opening in editor:', error);
    res.status(500).json({ error: 'Failed to open in editor' });
  }
});

// API: Get team config
app.get('/api/teams/:name', (req, res) => {
  const config = loadTeamConfig(req.params.name);
  if (!config) return res.status(404).json({ error: 'Team not found' });
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

    const files = readdirSync(agentDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const agents = [];
    for (const file of files) {
      try {
        const agent = JSON.parse(readFileSync(path.join(agentDir, file), 'utf8'));
        const agentStale = !sessionStale && agent.updatedAt && (Date.now() - new Date(agent.updatedAt).getTime()) > AGENT_STALE_MS;
        if (!isAgentFresh(agent) || sessionStale || agentStale) {
          if (agent.status === 'active' || agent.status === 'idle') {
            agent.status = 'stopped';
            if (!agent.stoppedAt) agent.stoppedAt = agent.updatedAt || agent.startedAt;
          }
        }
        agents.push(agent);
      } catch (e) { /* skip invalid */ }
    }
    const agentsNeedingPrompt = agents.filter(a => !a.prompt);
    if (agentsNeedingPrompt.length && meta.jsonlPath) {
      try {
        const progressMap = getProgressMap(meta.jsonlPath);
        const byAgentId = {};
        for (const entry of Object.values(progressMap)) {
          if (entry.prompt && !byAgentId[entry.agentId]) byAgentId[entry.agentId] = entry.prompt;
        }
        for (const agent of agentsNeedingPrompt) {
          const prompt = byAgentId[agent.agentId];
          if (prompt) {
            agent.prompt = prompt;
            const agentFile = path.join(agentDir, agent.agentId + '.json');
            fs.writeFile(agentFile, JSON.stringify(agent), 'utf8').catch(() => {});
          }
        }
      } catch (_) {}
    }
    const waitingForUser = checkWaitingForUser(agentDir, logMtime);
    res.json({ agents, waitingForUser });
  } catch (e) {
    res.json({ agents: [], waitingForUser: null });
  }
});

app.post('/api/sessions/:sessionId/agents/:agentId/stop', (req, res) => {
  const sessionId = resolveSessionId(req.params.sessionId);
  const agentId = path.basename(req.params.agentId).replace(/[^a-zA-Z0-9_-]/g, '');
  const agentFile = path.join(AGENT_ACTIVITY_DIR, sessionId, agentId + '.json');
  if (!existsSync(agentFile)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const agent = JSON.parse(readFileSync(agentFile, 'utf8'));
    agent.status = 'stopped';
    agent.stoppedAt = new Date().toISOString();
    writeFileSync(agentFile, JSON.stringify(agent), 'utf8');
    // Also remove waiting state if present
    const waitingFile = path.join(AGENT_ACTIVITY_DIR, sessionId, '_waiting.json');
    if (existsSync(waitingFile)) unlinkSync(waitingFile);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to stop agent' });
  }
});

app.get('/api/sessions/:sessionId/messages', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const metadata = loadSessionMetadata();
  const meta = metadata[req.params.sessionId];
  const jsonlPath = meta?.jsonlPath;
  if (!jsonlPath) return res.json({ messages: [], sessionId: req.params.sessionId });
  const messages = readRecentMessages(jsonlPath, limit);
  const agentMessages = messages.filter(m => m.tool === 'Agent' && m.toolUseId);
  if (agentMessages.length) {
    const progressMap = getProgressMap(jsonlPath);
    const resolvedSid = resolveSessionId(req.params.sessionId);
    const agentDir = path.join(AGENT_ACTIVITY_DIR, resolvedSid);
    for (const msg of agentMessages) {
      const entry = progressMap[msg.toolUseId];
      if (entry) {
        msg.agentId = entry.agentId;
        if (entry.prompt && !msg.agentPrompt) msg.agentPrompt = entry.prompt;
        try {
          const agentFile = path.join(agentDir, entry.agentId + '.json');
          const agent = JSON.parse(readFileSync(agentFile, 'utf8'));
          if (agent.lastMessage) msg.agentLastMessage = agent.lastMessage;
          if (agent.prompt && !msg.agentPrompt) msg.agentPrompt = agent.prompt;
          const prompt = msg.agentPrompt || entry.prompt;
          if (prompt && !agent.prompt) {
            agent.prompt = prompt;
            fs.writeFile(agentFile, JSON.stringify(agent), 'utf8').catch(() => {});
          }
        } catch (_) {}
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
  for (const msg of messages) {
    if (msg.toolUseId) delete msg.toolUseId;
    delete msg.promptId;
  }
  res.json({ messages, sessionId: req.params.sessionId });
});

app.get('/api/version', (req, res) => {
  const pkg = require('./package.json');
  res.json({ version: pkg.version });
});

// API: Get all tasks across all sessions
app.get('/api/tasks/all', async (req, res) => {
  try {
    if (!existsSync(TASKS_DIR)) {
      return res.json([]);
    }

    const metadata = loadSessionMetadata();
    const sessionDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    const allTasks = [];

    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(TASKS_DIR, sessionDir.name);
      const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
      const meta = metadata[sessionDir.name] || {};

      for (const file of taskFiles) {
        try {
          const task = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
          allTasks.push({
            ...task,
            sessionId: sessionDir.name,
            sessionName: getSessionDisplayName(sessionDir.name, meta),
            project: meta.project || null
          });
        } catch (e) {
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

// API: Add note to a task
app.post('/api/tasks/:sessionId/:taskId/note', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Note cannot be empty' });
    }

    const taskPath = path.join(TASKS_DIR, sessionId, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Read current task
    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));

    // Append note to description
    const noteBlock = `\n\n---\n\n#### [Note added by user]\n\n${note.trim()}`;
    task.description = (task.description || '') + noteBlock;

    // Write updated task
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

    res.json({ success: true, task });
  } catch (error) {
    console.error('Error adding note:', error);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// API: Update task fields (subject, description)
app.put('/api/tasks/:sessionId/:taskId', async (req, res) => {
  try {
    const { sessionId, taskId } = req.params;
    const { subject, description } = req.body;

    const taskPath = path.join(TASKS_DIR, sessionId, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = JSON.parse(await fs.readFile(taskPath, 'utf8'));

    if (subject !== undefined) task.subject = subject;
    if (description !== undefined) task.description = description;
    if (req.body.status !== undefined) task.status = req.body.status;

    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));

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
    const taskPath = path.join(TASKS_DIR, sessionId, `${taskId}.json`);

    if (!existsSync(taskPath)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Check if this task blocks other tasks
    const sessionPath = path.join(TASKS_DIR, sessionId);
    const taskFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));

    for (const file of taskFiles) {
      const otherTask = JSON.parse(readFileSync(path.join(sessionPath, file), 'utf8'));
      if (otherTask.blockedBy && otherTask.blockedBy.includes(taskId)) {
        return res.status(400).json({
          error: 'Cannot delete task that blocks other tasks',
          blockedTasks: [otherTask.id]
        });
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

app.get('/api/context-status', (req, res) => {
  res.json(Object.fromEntries(contextStatusCache));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// File watchers and server startup (skip for --install/--uninstall)
if (!isSetupCommand) {

// Watch for file changes (chokidar handles non-existent paths)
const watcher = chokidar.watch(TASKS_DIR, {
  persistent: true,
  ignoreInitial: true,
  depth: 2
});

watcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    const relativePath = path.relative(TASKS_DIR, filePath);
    const sessionId = relativePath.split(path.sep)[0];

    taskCountsCache.delete(path.join(TASKS_DIR, sessionId));

    broadcast({
      type: 'update',
      event,
      sessionId,
      file: path.basename(filePath)
    });
  }
});

console.log(`Watching for changes in: ${TASKS_DIR}`);

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
  depth: 2
});

projectsWatcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.jsonl')) {
    // Invalidate cache on any change
    lastMetadataRefresh = 0;
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
    lastMetadataRefresh = 0;
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
  depth: 2
});

const AGENT_FILE_CAP = 20;

agentActivityWatcher.on('all', (event, filePath) => {
  if ((event === 'add' || event === 'change' || event === 'unlink') && filePath.endsWith('.json')) {
    const relativePath = path.relative(AGENT_ACTIVITY_DIR, filePath);
    const sessionId = relativePath.split(path.sep)[0];
    // Cleanup: if session dir exceeds cap, delete oldest files by mtime
    if (event === 'add') {
      try {
        const sessionDir = path.join(AGENT_ACTIVITY_DIR, sessionId);
        const files = readdirSync(sessionDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
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
      } catch (e) { /* ignore */ }
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
      } catch (e) { /* ignore */ }
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
      contextStatusCache.set(sessionId, data);
      evictStaleCache(contextStatusCache);
    } catch (e) { /* ignore malformed */ }
    broadcast({ type: 'context-update', sessionId });
  } else if (event === 'unlink') {
    contextStatusCache.delete(sessionId);
    broadcast({ type: 'context-update', sessionId });
  }
});

const CTX_CLEANUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
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
      } catch (e) { /* ignore */ }
    }
  } catch (e) { /* dir may not exist */ }
}

// Cleanup agent-activity folders older than 2 days
const CLEANUP_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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
        }
      } catch (e) { /* ignore per-folder errors */ }
    }
  } catch (e) { /* agent-activity dir may not exist */ }
}

cleanupAgentActivity();
cleanupContextStatus();
setInterval(cleanupAgentActivity, CLEANUP_INTERVAL_MS);
setInterval(cleanupContextStatus, 30 * 60 * 1000);

const server = app.listen(PORT, () => {
    const actualPort = server.address().port;
    console.log(`Claude Task Kanban running at http://localhost:${actualPort}`);

    if (process.argv.includes('--open')) {
      import('open').then(open => open.default(`http://localhost:${actualPort}`));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${PORT} in use, trying random port...`);
      const fallback = app.listen(0, () => {
        const actualPort = fallback.address().port;
        console.log(`Claude Task Kanban running at http://localhost:${actualPort}`);

        if (process.argv.includes('--open')) {
          import('open').then(open => open.default(`http://localhost:${actualPort}`));
        }
      });
    } else {
      throw err;
    }
  });

} // end if (!isSetupCommand)
