const fs = require('fs');
const { readFileSync, existsSync, readdirSync, statSync } = fs;
const path = require('path');

function parseTask(raw) {
  const task = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    id: task.id,
    subject: task.subject,
    description: task.description || null,
    status: task.status,
    blocks: task.blocks || [],
    blockedBy: task.blockedBy || [],
    isInternal: !!(task.metadata && task.metadata._internal),
    raw: task
  };
}

function parseAgent(raw) {
  const agent = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    agentId: agent.agentId,
    type: agent.type || null,
    status: agent.status,
    startedAt: agent.startedAt,
    stoppedAt: agent.stoppedAt || null,
    updatedAt: agent.updatedAt || null,
    lastMessage: agent.lastMessage || null,
    prompt: agent.prompt || null,
    raw: agent
  };
}

function parseWaiting(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    status: data.status,
    kind: data.kind || null,
    toolName: data.toolName || null,
    toolInput: data.toolInput || null,
    timestamp: data.timestamp,
    raw: data
  };
}

function parseTeamConfig(raw) {
  const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    name: config.name,
    description: config.description || null,
    leadAgentId: config.leadAgentId,
    leadSessionId: config.leadSessionId || null,
    members: (config.members || []).map(m => ({
      agentId: m.agentId,
      name: m.name,
      agentType: m.agentType || null,
      model: m.model || null,
      cwd: m.cwd || null
    })),
    raw: config
  };
}

function parseSessionsIndex(raw) {
  const index = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    version: index.version || null,
    entries: (index.entries || []).map(e => ({
      sessionId: e.sessionId,
      description: e.description || null,
      gitBranch: e.gitBranch || null,
      created: e.created || null,
      projectPath: e.projectPath || null,
      isSidechain: e.isSidechain || false
    })),
    raw: index
  };
}

function parseJsonlLine(line) {
  const obj = typeof line === 'string' ? JSON.parse(line) : line;
  const base = {
    type: obj.type,
    timestamp: obj.timestamp || null,
    sessionId: obj.sessionId || null,
    uuid: obj.uuid || null
  };

  if (obj.type === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
    const blocks = obj.message.content.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'tool_use') return { type: 'tool_use', name: block.name, input: block.input || null };
      if (block.type === 'thinking') return { type: 'thinking' };
      return { type: block.type };
    });
    return { ...base, role: 'assistant', model: obj.message.model || null, blocks };
  }

  if (obj.type === 'user' && obj.message?.role === 'user') {
    return {
      ...base,
      role: 'user',
      isMeta: !!obj.isMeta,
      content: typeof obj.message.content === 'string' ? obj.message.content : null
    };
  }

  if (obj.type === 'progress') {
    return { ...base, cwd: obj.cwd || null, version: obj.version || null, slug: obj.slug || null };
  }

  return base;
}

// Cache: jsonlPath -> { scannedUpTo, customTitle }
// Only re-scan the new bytes appended since last scan
const customTitleCache = new Map();
const CUSTOM_TITLE_SCAN_SIZE = 1048576; // 1MB max scan on first read

function readCustomTitle(jsonlPath, existingStat) {
  try {
    const stat = existingStat || statSync(jsonlPath);
    const cached = customTitleCache.get(jsonlPath);

    if (cached && cached.scannedUpTo >= stat.size) return cached.customTitle;

    let customTitle = cached?.customTitle || null;
    const fd = fs.openSync(jsonlPath, 'r');

    // On first scan, read last 256KB; on subsequent, only read new bytes
    const scanStart = cached
      ? cached.scannedUpTo
      : Math.max(0, stat.size - CUSTOM_TITLE_SCAN_SIZE);
    const len = stat.size - scanStart;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, scanStart);
      const text = buf.toString('utf8');
      if (text.includes('"custom-title"')) {
        const lines = text.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i].includes('"custom-title"')) continue;
          try {
            const data = JSON.parse(lines[i]);
            if (data.type === 'custom-title' && data.customTitle) {
              customTitle = data.customTitle;
              break;
            }
          } catch (e) {}
        }
      }
    }

    fs.closeSync(fd);
    customTitleCache.set(jsonlPath, { scannedUpTo: stat.size, customTitle });
    return customTitle;
  } catch (e) {
    return null;
  }
}

function readSessionInfoFromJsonl(jsonlPath) {
  const result = { slug: null, projectPath: null, gitBranch: null, customTitle: null };
  let stat;
  try {
    stat = statSync(jsonlPath);
    const fd = fs.openSync(jsonlPath, 'r');
    const HEAD_SIZE = 16384;
    const TAIL_SIZE = 16384;

    const headBuf = Buffer.alloc(Math.min(HEAD_SIZE, stat.size));
    const hn = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    for (const line of headBuf.toString('utf8', 0, hn).split('\n')) {
      try {
        const data = JSON.parse(line);
        if (data.slug) result.slug = data.slug;
        if (data.cwd) result.projectPath = data.cwd;
        if (data.gitBranch) result.gitBranch = data.gitBranch;
        if (result.slug && result.projectPath && result.gitBranch) break;
      } catch (e) {}
    }

    if ((!result.slug || !result.projectPath || !result.gitBranch) && stat.size > HEAD_SIZE) {
      const tailStart = stat.size - TAIL_SIZE;
      const tailBuf = Buffer.alloc(TAIL_SIZE);
      const tn = fs.readSync(fd, tailBuf, 0, TAIL_SIZE, tailStart);
      const lines = tailBuf.toString('utf8', 0, tn).split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const data = JSON.parse(lines[i]);
          if (!result.slug && data.slug) result.slug = data.slug;
          if (!result.projectPath && data.cwd) result.projectPath = data.cwd;
          if (!result.gitBranch && data.gitBranch) result.gitBranch = data.gitBranch;
          if (result.slug && result.projectPath && result.gitBranch) break;
        } catch (e) {}
      }
    }

    fs.closeSync(fd);
  } catch (e) {}

  result.customTitle = readCustomTitle(jsonlPath, stat);
  return result;
}

function readRecentMessages(jsonlPath, limit = 10) {
  let fd;
  try {
    const stat = statSync(jsonlPath);
    fd = require('fs').openSync(jsonlPath, 'r');
    const messages = [];
    let readSize = Math.min(65536, stat.size);

    while (messages.length < limit && readSize <= stat.size) {
      const start = Math.max(0, stat.size - readSize);
      const bufSize = Math.min(readSize, stat.size);
      const buf = Buffer.alloc(bufSize);
      require('fs').readSync(fd, buf, 0, bufSize, start);

      const text = buf.toString('utf8');
      const firstNewline = text.indexOf('\n');
      const clean = firstNewline >= 0 ? text.substring(firstNewline + 1) : text;

      messages.length = 0;
      for (const line of clean.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'assistant' && obj.message?.content && Array.isArray(obj.message.content)) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text) {
                const truncated = block.text.length > 500;
                messages.push({
                  type: 'assistant',
                  text: truncated ? block.text.slice(0, 500) + '...' : block.text,
                  fullText: truncated ? block.text : null,
                  timestamp: obj.timestamp,
                  model: obj.message.model || null
                });
              } else if (block.type === 'tool_use') {
                let detail = null;
                let fullDetail = null;
                let inp = null;
                if (block.input) {
                  inp = typeof block.input === 'string' ? (() => { try { return JSON.parse(block.input); } catch(_) { return {}; } })() : block.input;
                  if (inp.file_path) { detail = inp.file_path.replace(/^.*[/\\]/, ''); fullDetail = inp.file_path; }
                  else if (inp.command) { detail = inp.command.length > 80 ? inp.command.slice(0, 80) + '...' : inp.command; fullDetail = inp.command; }
                  else if (inp.pattern) { detail = inp.pattern; fullDetail = inp.pattern; }
                  else if (inp.query) { detail = inp.query; fullDetail = inp.query; }
                  else if (inp.url) { detail = inp.url.length > 80 ? inp.url.slice(0, 80) + '...' : inp.url; fullDetail = inp.url; }
                  else if (inp.skill) { const s = inp.skill + (typeof inp.args === 'string' ? ' ' + inp.args : ''); detail = s.length > 80 ? s.slice(0, 80) + '...' : s; fullDetail = s; }
                  else if (inp.questions && Array.isArray(inp.questions)) {
                    const parts = inp.questions.map(q => (q.header ? q.header + ': ' : '') + q.question);
                    const s = parts.join(' | ');
                    detail = s.length > 80 ? s.slice(0, 80) + '...' : s;
                    fullDetail = inp.questions.map(q => {
                      let text = (q.header ? '[' + q.header + '] ' : '') + q.question;
                      if (q.options) text += '\n\n' + q.options.map((o, j) => '  ' + (j + 1) + '. ' + o.label + (o.description ? ' — ' + o.description : '')).join('\n');
                      return text;
                    }).join('\n\n');
                  }
                  else if (inp.description) { detail = inp.description; fullDetail = inp.description; }
                }
                const msg = {
                  type: 'tool_use',
                  tool: block.name,
                  detail,
                  fullDetail: fullDetail !== detail ? fullDetail : null,
                  description: inp?.description || null,
                  timestamp: obj.timestamp
                };
                if (block.name === 'Agent') {
                  if (block.id) msg.toolUseId = block.id;
                  if (inp) {
                    msg.agentType = inp.subagent_type || null;
                    if (inp.prompt) msg.agentPrompt = inp.prompt;
                  }
                }
                messages.push(msg);
              }
            }
          } else if (obj.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
            if (typeof obj.message.content === 'string') {
              const t = obj.message.content;
              const uTruncated = t.length > 500;
              messages.push({
                type: 'user',
                text: uTruncated ? t.slice(0, 500) + '...' : t,
                fullText: uTruncated ? t : null,
                timestamp: obj.timestamp
              });
            }
          }
        } catch (e) { /* partial line */ }
      }

      if (readSize >= stat.size) break;
      readSize *= 4;
    }

    require('fs').closeSync(fd);
    fd = null;
    return messages.slice(-limit);
  } catch (e) {
    if (fd) try { require('fs').closeSync(fd); } catch (_) {}
    return [];
  }
}

function buildAgentProgressMap(jsonlPath) {
  const map = {};
  try {
    const content = readFileSync(jsonlPath, 'utf8');
    const re = /"type":"agent_progress"[^}]*"agentId":"([^"]+)"/;
    const parentRe = /"parentToolUseID":"([^"]+)"/;
    const promptRe = /"prompt":"((?:[^"\\]|\\.)*)"/;
    const bgToolIdRe = /"tool_use_id":"([^"]+)"/;
    const bgAgentIdRe = /agentId: ([a-zA-Z0-9_-]+)/;
    for (const line of content.split('\n')) {
      if (line.includes('"agent_progress"')) {
        const agentMatch = re.exec(line);
        const parentMatch = parentRe.exec(line);
        if (agentMatch && parentMatch) {
          const key = parentMatch[1];
          if (!map[key]) {
            let prompt = null;
            const promptMatch = promptRe.exec(line);
            if (promptMatch && promptMatch[1]) {
              try { prompt = JSON.parse('"' + promptMatch[1] + '"'); } catch (_) { prompt = promptMatch[1]; }
            }
            map[key] = { agentId: agentMatch[1], prompt };
          }
        }
      } else if (line.includes('Async agent launched')) {
        const toolIdMatch = bgToolIdRe.exec(line);
        const bgAgentMatch = bgAgentIdRe.exec(line);
        if (toolIdMatch && bgAgentMatch && !map[toolIdMatch[1]]) {
          map[toolIdMatch[1]] = { agentId: bgAgentMatch[1], prompt: null };
        }
      }
    }
  } catch (_) {}
  return map;
}

module.exports = {
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  readSessionInfoFromJsonl,
  readRecentMessages,
  buildAgentProgressMap
};
