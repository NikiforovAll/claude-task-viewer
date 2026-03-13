const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const {
  parseTask,
  parseAgent,
  parseWaiting,
  parseTeamConfig,
  parseSessionsIndex,
  parseJsonlLine,
  readRecentMessages,
  buildAgentProgressMap
} = require('../lib/parsers');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SCHEMAS_DIR = path.join(__dirname, 'schemas');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadSchema(name) {
  return JSON.parse(readFileSync(path.join(SCHEMAS_DIR, name), 'utf8'));
}

function loadFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function loadFixtureJson(name) {
  return JSON.parse(loadFixture(name));
}

// --- Schema validation tests ---

describe('Schema: Task JSON', () => {
  const validate = ajv.compile(loadSchema('task.schema.json'));

  it('validates completed task', () => {
    assert.ok(validate(loadFixtureJson('task-completed.json')), JSON.stringify(validate.errors));
  });

  it('validates in-progress task', () => {
    assert.ok(validate(loadFixtureJson('task-in-progress.json')), JSON.stringify(validate.errors));
  });

  it('validates pending task', () => {
    assert.ok(validate(loadFixtureJson('task-pending.json')), JSON.stringify(validate.errors));
  });

  it('validates internal task', () => {
    assert.ok(validate(loadFixtureJson('task-internal.json')), JSON.stringify(validate.errors));
  });

  it('rejects task with invalid status', () => {
    assert.ok(!validate({ id: '1', subject: 'test', status: 'unknown' }));
  });

  it('rejects task without required fields', () => {
    assert.ok(!validate({ subject: 'test' }));
  });
});

describe('Schema: Agent JSON', () => {
  const validate = ajv.compile(loadSchema('agent.schema.json'));

  it('validates active agent', () => {
    assert.ok(validate(loadFixtureJson('agent-active.json')), JSON.stringify(validate.errors));
  });

  it('validates stopped agent', () => {
    assert.ok(validate(loadFixtureJson('agent-stopped.json')), JSON.stringify(validate.errors));
  });

  it('rejects agent with invalid status', () => {
    assert.ok(!validate({ agentId: 'x', status: 'running', startedAt: '2026-01-01T00:00:00Z' }));
  });

  it('rejects agent without agentId', () => {
    assert.ok(!validate({ status: 'active', startedAt: '2026-01-01T00:00:00Z' }));
  });
});

describe('Schema: Waiting JSON', () => {
  const validate = ajv.compile(loadSchema('waiting.schema.json'));

  it('validates waiting-for-permission', () => {
    assert.ok(validate(loadFixtureJson('waiting-permission.json')), JSON.stringify(validate.errors));
  });

  it('rejects without timestamp', () => {
    assert.ok(!validate({ status: 'waiting' }));
  });
});

describe('Schema: Team Config', () => {
  const validate = ajv.compile(loadSchema('team-config.schema.json'));

  it('validates team config', () => {
    assert.ok(validate(loadFixtureJson('team-config.json')), JSON.stringify(validate.errors));
  });

  it('rejects without members', () => {
    assert.ok(!validate({ name: 'test', leadAgentId: 'x' }));
  });
});

describe('Schema: Sessions Index', () => {
  const validate = ajv.compile(loadSchema('sessions-index.schema.json'));

  it('validates sessions index', () => {
    assert.ok(validate(loadFixtureJson('sessions-index.json')), JSON.stringify(validate.errors));
  });

  it('rejects without entries', () => {
    assert.ok(!validate({ version: 1 }));
  });
});

describe('Schema: Session JSONL Lines', () => {
  const validate = ajv.compile(loadSchema('session-jsonl-line.schema.json'));

  it('validates all lines in fixture JSONL', () => {
    const lines = loadFixture('session.jsonl').trim().split('\n');
    for (const line of lines) {
      const obj = JSON.parse(line);
      const valid = validate(obj);
      assert.ok(valid, `Line type="${obj.type}" failed: ${JSON.stringify(validate.errors)}`);
    }
  });
});

// --- Parser unit tests ---

describe('Parser: parseTask', () => {
  it('parses completed task', () => {
    const task = parseTask(loadFixture('task-completed.json'));
    assert.equal(task.id, '1');
    assert.equal(task.status, 'completed');
    assert.equal(task.isInternal, false);
  });

  it('detects internal tasks', () => {
    const task = parseTask(loadFixture('task-internal.json'));
    assert.equal(task.isInternal, true);
  });

  it('handles missing optional fields', () => {
    const task = parseTask('{"id":"1","subject":"test","status":"pending"}');
    assert.equal(task.description, null);
    assert.deepEqual(task.blocks, []);
    assert.deepEqual(task.blockedBy, []);
  });
});

describe('Parser: parseAgent', () => {
  it('parses active agent', () => {
    const agent = parseAgent(loadFixture('agent-active.json'));
    assert.equal(agent.agentId, 'abc123def456');
    assert.equal(agent.status, 'active');
    assert.equal(agent.stoppedAt, null);
  });

  it('parses stopped agent', () => {
    const agent = parseAgent(loadFixture('agent-stopped.json'));
    assert.equal(agent.status, 'stopped');
    assert.ok(agent.stoppedAt);
  });
});

describe('Parser: parseWaiting', () => {
  it('parses permission waiting', () => {
    const w = parseWaiting(loadFixture('waiting-permission.json'));
    assert.equal(w.status, 'waiting');
    assert.equal(w.kind, 'permission');
    assert.equal(w.toolName, 'Bash');
  });
});

describe('Parser: parseTeamConfig', () => {
  it('parses team config with members', () => {
    const config = parseTeamConfig(loadFixture('team-config.json'));
    assert.equal(config.name, 'test-team-alpha');
    assert.equal(config.members.length, 2);
    assert.equal(config.members[0].agentType, 'team-lead');
    assert.equal(config.leadSessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

describe('Parser: parseSessionsIndex', () => {
  it('parses sessions index', () => {
    const index = parseSessionsIndex(loadFixture('sessions-index.json'));
    assert.equal(index.entries.length, 2);
    assert.equal(index.entries[0].gitBranch, 'feat/logging');
    assert.equal(index.entries[1].description, 'Quick fix session');
  });
});

describe('Parser: parseJsonlLine', () => {
  const lines = readFileSync(path.join(FIXTURES_DIR, 'session.jsonl'), 'utf8').trim().split('\n');

  it('parses progress/meta line', () => {
    const parsed = parseJsonlLine(lines[0]);
    assert.equal(parsed.type, 'progress');
    assert.equal(parsed.slug, 'test-session');
    assert.equal(parsed.cwd, '/home/user/project');
  });

  it('parses user message', () => {
    const parsed = parseJsonlLine(lines[1]);
    assert.equal(parsed.role, 'user');
    assert.equal(parsed.content, 'Fix the login bug');
    assert.equal(parsed.isMeta, false);
  });

  it('parses assistant text message', () => {
    const parsed = parseJsonlLine(lines[2]);
    assert.equal(parsed.role, 'assistant');
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].type, 'text');
  });

  it('parses assistant tool_use message', () => {
    const parsed = parseJsonlLine(lines[3]);
    assert.equal(parsed.role, 'assistant');
    assert.equal(parsed.blocks.length, 2);
    assert.equal(parsed.blocks[0].type, 'tool_use');
    assert.equal(parsed.blocks[0].name, 'Read');
    assert.equal(parsed.blocks[1].name, 'Bash');
  });

  it('parses file-history-snapshot', () => {
    const parsed = parseJsonlLine(lines[6]);
    assert.equal(parsed.type, 'file-history-snapshot');
  });
});

describe('Parser: readRecentMessages', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('reads messages from JSONL file', () => {
    const messages = readRecentMessages(jsonlPath, 10);
    assert.ok(messages.length > 0);
    const types = messages.map(m => m.type);
    assert.ok(types.includes('user'));
    assert.ok(types.includes('assistant'));
  });

  it('includes tool_use messages', () => {
    const messages = readRecentMessages(jsonlPath, 10);
    const toolMsgs = messages.filter(m => m.type === 'tool_use');
    assert.ok(toolMsgs.length > 0);
    assert.ok(toolMsgs.some(m => m.tool === 'Read'));
    assert.ok(toolMsgs.some(m => m.tool === 'Bash'));
  });

  it('extracts file_path detail for Read tool', () => {
    const messages = readRecentMessages(jsonlPath, 10);
    const readMsg = messages.find(m => m.tool === 'Read');
    assert.equal(readMsg.detail, 'login.ts');
    assert.equal(readMsg.fullDetail, '/home/user/project/src/auth/login.ts');
  });

  it('extracts command detail for Bash tool', () => {
    const messages = readRecentMessages(jsonlPath, 10);
    const bashMsg = messages.find(m => m.tool === 'Bash');
    assert.ok(bashMsg.detail);
  });

  it('respects limit', () => {
    const messages = readRecentMessages(jsonlPath, 2);
    assert.ok(messages.length <= 2);
  });

  it('returns empty for non-existent file', () => {
    const messages = readRecentMessages('/nonexistent/path.jsonl', 10);
    assert.deepEqual(messages, []);
  });

  it('extracts Agent tool fields (toolUseId, agentType, agentPrompt)', () => {
    const messages = readRecentMessages(jsonlPath, 20);
    const agentMsg = messages.find(m => m.tool === 'Agent');
    assert.ok(agentMsg, 'should find an Agent tool_use message');
    assert.equal(agentMsg.toolUseId, 'tu_agent_01');
    assert.equal(agentMsg.agentType, 'Explore');
    assert.equal(agentMsg.agentPrompt, 'Find all auth middleware files');
  });

  it('attaches tool_result to matching tool_use messages', () => {
    const messages = readRecentMessages(jsonlPath, 20);
    const readMsg = messages.find(m => m.tool === 'Read');
    assert.ok(readMsg, 'should find a Read tool_use message');
    assert.ok(readMsg.toolResult, 'Read message should have toolResult');
    assert.ok(readMsg.toolResult.includes('import { hash }'), 'toolResult should contain file content');

    const bashMsg = messages.find(m => m.tool === 'Bash');
    assert.ok(bashMsg, 'should find a Bash tool_use message');
    assert.ok(bashMsg.toolResult, 'Bash message should have toolResult');
    assert.ok(bashMsg.toolResult.includes('authenticate'), 'toolResult should contain grep output');
  });
});

describe('Parser: buildAgentProgressMap', () => {
  const jsonlPath = path.join(FIXTURES_DIR, 'session.jsonl');

  it('maps parentToolUseID to agentId and prompt', () => {
    const map = buildAgentProgressMap(jsonlPath);
    assert.equal(map['tu_agent_01'].agentId, 'agent-abc-123');
    assert.equal(map['tu_agent_01'].prompt, 'Find all auth middleware files');
  });

  it('maps background agent tool_result to agentId', () => {
    const map = buildAgentProgressMap(jsonlPath);
    assert.equal(map['tu_bg_agent_01'].agentId, 'agent-bg-456');
    assert.equal(map['tu_bg_agent_01'].prompt, null);
  });

  it('returns empty map for non-existent file', () => {
    const map = buildAgentProgressMap('/nonexistent/path.jsonl');
    assert.deepEqual(map, {});
  });
});
