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

const TOOL_RESULT_MAX = 1500;

// Cache: jsonlPath -> { scannedUpTo, customTitle }
// Only re-scan the new bytes appended since last scan
const customTitleCache = new Map();
const CUSTOM_TITLE_SCAN_SIZE = 1048576; // 1MB max scan on first read

function extractCustomTitleFromText(text) {
  if (!text.includes('"custom-title"')) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"custom-title"')) continue;
    try {
      const data = JSON.parse(lines[i]);
      if (data.type === 'custom-title' && data.customTitle && !data.customTitle.startsWith('<')) {
        return data.customTitle;
      }
    } catch (e) {}
  }
  return null;
}

function readCustomTitle(jsonlPath, existingStat) {
  try {
    const stat = existingStat || statSync(jsonlPath);
    const cached = customTitleCache.get(jsonlPath);

    if (cached && cached.scannedUpTo >= stat.size) return cached.customTitle;

    let customTitle = cached?.customTitle || null;
    const fd = fs.openSync(jsonlPath, 'r');

    if (cached) {
      const len = stat.size - cached.scannedUpTo;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, cached.scannedUpTo);
        customTitle = extractCustomTitleFromText(buf.toString('utf8')) || customTitle;
      }
    } else {
      const CHUNK = CUSTOM_TITLE_SCAN_SIZE;
      for (let offset = 0; offset < stat.size; offset += CHUNK) {
        const len = Math.min(CHUNK, stat.size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        const found = extractCustomTitleFromText(buf.toString('utf8'));
        if (found) customTitle = found;
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

function getSystemMessageLabel(text) {
  const taskMatch = text.match(/<summary>([^<]+)<\/summary>/);
  if (taskMatch) return taskMatch[1].trim();
  if (text.includes('<task-notification>')) {
    const statusMatch = text.match(/<status>([^<]+)<\/status>/);
    return statusMatch ? `Background task ${statusMatch[1]}` : 'Background task notification';
  }
  if (text.includes('<local-command-stdout>') && text.includes('Compacted')) return 'Compacted';
  if (text.includes('<local-command-stdout>')) return 'Command output';
  if (text.includes('<local-command-caveat>')) return 'System notification';
  if (text.includes('.output completed') && text.includes('Background command')) return 'Background task completed';
  if (text.startsWith('This session is being continued from a previous conversation')) return '__skip__';
  return null;
}

function readRecentMessages(jsonlPath, limit = 10) {
  let fd;
  try {
    const stat = statSync(jsonlPath);
    fd = require('fs').openSync(jsonlPath, 'r');
    const messages = [];
    const toolResults = new Map();
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
      toolResults.clear();
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
                const params = {};
                if (inp) {
                  if (block.name === 'Edit') {
                    if (inp.old_string) params.old_string = inp.old_string;
                    if (inp.new_string) params.new_string = inp.new_string;
                    if (inp.replace_all) params.replace_all = true;
                  } else if (block.name === 'Write') {
                    if (inp.content) params.content = inp.content.length > TOOL_RESULT_MAX ? inp.content.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)' : inp.content;
                  } else if (block.name === 'Grep') {
                    if (inp.path) params.path = inp.path;
                    if (inp.glob) params.glob = inp.glob;
                    if (inp.type) params.type = inp.type;
                    if (inp.output_mode) params.output_mode = inp.output_mode;
                    if (inp['-i']) params.case_insensitive = true;
                    if (inp['-A']) params.after = inp['-A'];
                    if (inp['-B']) params.before = inp['-B'];
                    if (inp['-C'] || inp.context) params.context = inp['-C'] || inp.context;
                    if (inp.multiline) params.multiline = true;
                    if (inp.head_limit) params.head_limit = inp.head_limit;
                  } else if (block.name === 'Glob') {
                    if (inp.path) params.path = inp.path;
                  } else if (block.name === 'Bash') {
                    if (inp.timeout) params.timeout = inp.timeout;
                    if (inp.run_in_background) params.background = true;
                  } else if (block.name === 'Read') {
                    if (inp.offset) params.offset = inp.offset;
                    if (inp.limit) params.limit = inp.limit;
                    if (inp.pages) params.pages = inp.pages;
                  } else if (block.name === 'WebFetch') {
                    if (inp.prompt) params.prompt = inp.prompt;
                  } else if (block.name === 'WebSearch') {
                    if (inp.max_results) params.max_results = inp.max_results;
                    if (inp.allowed_domains) params.allowed_domains = inp.allowed_domains.join(', ');
                    if (inp.blocked_domains) params.blocked_domains = inp.blocked_domains.join(', ');
                  } else if (block.name === 'LSP') {
                    if (inp.operation) params.operation = inp.operation;
                    if (inp.filePath) params.filePath = inp.filePath;
                    if (inp.line != null) params.line = inp.line;
                    if (inp.character != null) params.character = inp.character;
                  } else if (block.name === 'ToolSearch') {
                    if (inp.max_results) params.max_results = inp.max_results;
                  } else if (block.name === 'TaskCreate') {
                    if (inp.description) params.description = inp.description;
                  } else if (block.name === 'TaskUpdate') {
                    if (inp.taskId) params.taskId = inp.taskId;
                    if (inp.status) params.status = inp.status;
                  } else if (block.name === 'NotebookEdit') {
                    if (inp.command) params.command = inp.command;
                    if (inp.cell_type) params.cell_type = inp.cell_type;
                  } else if (block.name === 'Agent') {
                    if (inp.mode) params.mode = inp.mode;
                    if (inp.model) params.model = inp.model;
                    if (inp.run_in_background) params.background = true;
                    if (inp.isolation) params.isolation = inp.isolation;
                  }
                }
                const msg = {
                  type: 'tool_use',
                  tool: block.name,
                  detail,
                  fullDetail: fullDetail !== detail ? fullDetail : null,
                  description: inp?.description || null,
                  params: Object.keys(params).length > 0 ? params : null,
                  timestamp: obj.timestamp
                };
                if (block.id) msg.toolUseId = block.id;
                if (block.name === 'Agent') {
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
              const sysLabel = getSystemMessageLabel(t);
              if (sysLabel === '__skip__') continue;
              const uTruncated = t.length > 500;
              messages.push({
                type: 'user',
                text: uTruncated ? t.slice(0, 500) + '...' : t,
                fullText: uTruncated ? t : null,
                timestamp: obj.timestamp,
                ...(sysLabel && { systemLabel: sysLabel })
              });
            } else if (Array.isArray(obj.message.content)) {
              for (const block of obj.message.content) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  let resultText = '';
                  if (typeof block.content === 'string') {
                    resultText = block.content;
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter(c => c.type === 'text' && c.text)
                      .map(c => c.text)
                      .join('\n');
                  }
                  if (resultText) {
                    toolResults.set(block.tool_use_id, resultText);
                  }
                }
              }
            }
          }
        } catch (e) { /* partial line */ }
      }

      if (readSize >= stat.size) break;
      readSize *= 4;
    }

    // Attach tool results to their corresponding tool_use messages
    for (const msg of messages) {
      if (msg.type === 'tool_use' && msg.toolUseId && toolResults.has(msg.toolUseId)) {
        const full = toolResults.get(msg.toolUseId);
        const truncated = full.length > TOOL_RESULT_MAX;
        msg.toolResult = truncated ? full.slice(0, TOOL_RESULT_MAX) + '\n... (truncated)' : full;
        msg.toolResultTruncated = truncated;
        if (truncated) msg.toolResultFull = full;
      }
    }

    require('fs').closeSync(fd);
    fd = null;
    messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
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

function readCompactSummaries(jsonlPath) {
  const results = [];
  try {
    const subagentsDir = path.join(path.dirname(jsonlPath), path.basename(jsonlPath, '.jsonl'), 'subagents');
    const files = readdirSync(subagentsDir).filter(f => f.startsWith('agent-acompact-') && f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(subagentsDir, file);
      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      // Use last entry timestamp (closest to when compaction completed)
      let lastTs;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try { lastTs = JSON.parse(lines[i]).timestamp; if (lastTs) break; } catch (_) {}
      }
      if (!lastTs) continue;
      // Find the last assistant message with a <summary> tag
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type !== 'assistant') continue;
          const blocks = obj.message?.content;
          if (!Array.isArray(blocks)) continue;
          let found = false;
          for (const b of blocks) {
            if (b.type !== 'text' || !b.text) continue;
            const match = b.text.match(/<summary>([\s\S]*?)(?:<\/summary>|$)/);
            if (match) { results.push({ timestamp: lastTs, summary: match[1].trim() }); found = true; break; }
          }
          if (found) break;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return results.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
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
  buildAgentProgressMap,
  readCompactSummaries
};
