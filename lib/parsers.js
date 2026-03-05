const { readFileSync, existsSync, readdirSync, statSync } = require('fs');
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

function readSessionInfoFromJsonl(jsonlPath) {
  const result = { slug: null, projectPath: null };
  try {
    if (!existsSync(jsonlPath)) return result;
    const fd = require('fs').openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(4096);
    const n = require('fs').readSync(fd, buf, 0, 4096, 0);
    require('fs').closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const data = JSON.parse(line);
        if (data.slug) result.slug = data.slug;
        if (data.cwd) result.projectPath = data.cwd;
        if (result.slug && result.projectPath) break;
      } catch (e) {}
    }
  } catch (e) {}
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
                  else if (inp.description) { detail = inp.description; fullDetail = inp.description; }
                }
                messages.push({
                  type: 'tool_use',
                  tool: block.name,
                  detail,
                  fullDetail: fullDetail !== detail ? fullDetail : null,
                  description: inp?.description || null,
                  timestamp: obj.timestamp
                });
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

module.exports = {
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  readSessionInfoFromJsonl,
  readRecentMessages
};
