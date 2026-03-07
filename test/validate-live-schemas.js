#!/usr/bin/env node

const { readFileSync, existsSync, readdirSync, statSync } = require('fs');
const path = require('path');
const os = require('os');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const SCHEMAS_DIR = path.join(__dirname, 'schemas');
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');

const schemas = {
  task: ajv.compile(JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'task.schema.json'), 'utf8'))),
  agent: ajv.compile(JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'agent.schema.json'), 'utf8'))),
  waiting: ajv.compile(JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'waiting.schema.json'), 'utf8'))),
  teamConfig: ajv.compile(JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'team-config.schema.json'), 'utf8'))),
  sessionsIndex: ajv.compile(JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'sessions-index.schema.json'), 'utf8'))),
  jsonlLine: ajv.compile(JSON.parse(readFileSync(path.join(SCHEMAS_DIR, 'session-jsonl-line.schema.json'), 'utf8')))
};

let total = 0;
let passed = 0;
let failed = 0;
const failures = [];

function check(schemaName, filePath, data) {
  total++;
  const validate = schemas[schemaName];
  if (validate(data)) {
    passed++;
  } else {
    failed++;
    failures.push({ schemaName, filePath, errors: validate.errors });
  }
}

function validateDir(dir, schemaName, fileFilter = f => f.endsWith('.json')) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const subdir = path.join(dir, entry.name);
      for (const file of readdirSync(subdir).filter(fileFilter)) {
        try {
          const filePath = path.join(subdir, file);
          const data = JSON.parse(readFileSync(filePath, 'utf8'));
          check(schemaName, filePath, data);
        } catch (e) { /* skip unparseable */ }
      }
    }
  }
}

console.log(`Validating live Claude Code files in ${CLAUDE_DIR}\n`);

// 1. Task files
const tasksDir = path.join(CLAUDE_DIR, 'tasks');
console.log('Tasks...');
validateDir(tasksDir, 'task');

// 2. Agent activity files
const agentDir = path.join(CLAUDE_DIR, 'agent-activity');
console.log('Agents...');
if (existsSync(agentDir)) {
  for (const entry of readdirSync(agentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.join(agentDir, entry.name);
    for (const file of readdirSync(sessionDir).filter(f => f.endsWith('.json'))) {
      try {
        const filePath = path.join(sessionDir, file);
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        if (file === '_waiting.json') {
          check('waiting', filePath, data);
        } else {
          check('agent', filePath, data);
        }
      } catch (e) { /* skip */ }
    }
  }
}

// 3. Team configs
const teamsDir = path.join(CLAUDE_DIR, 'teams');
console.log('Teams...');
if (existsSync(teamsDir)) {
  for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(teamsDir, entry.name, 'config.json');
    if (existsSync(configPath)) {
      try {
        check('teamConfig', configPath, JSON.parse(readFileSync(configPath, 'utf8')));
      } catch (e) { /* skip */ }
    }
  }
}

// 4. Sessions index files
const projectsDir = path.join(CLAUDE_DIR, 'projects');
console.log('Sessions indexes...');
if (existsSync(projectsDir)) {
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(projectsDir, entry.name, 'sessions-index.json');
    if (existsSync(indexPath)) {
      try {
        check('sessionsIndex', indexPath, JSON.parse(readFileSync(indexPath, 'utf8')));
      } catch (e) { /* skip */ }
    }
  }
}

// 5. Sample JSONL lines (first 5 lines from up to 3 recent JSONL files)
console.log('JSONL samples...');
if (existsSync(projectsDir)) {
  let jsonlCount = 0;
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || jsonlCount >= 3) continue;
    const projPath = path.join(projectsDir, entry.name);
    const jsonls = readdirSync(projPath).filter(f => f.endsWith('.jsonl'));
    // Pick the most recently modified JSONL
    const sorted = jsonls
      .map(f => ({ f, mtime: statSync(path.join(projPath, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (sorted.length === 0) continue;
    const filePath = path.join(projPath, sorted[0].f);
    try {
      const head = readFileSync(filePath, 'utf8').split('\n').slice(0, 5);
      for (const line of head) {
        if (!line.trim()) continue;
        try {
          check('jsonlLine', filePath, JSON.parse(line));
        } catch (e) { /* skip partial */ }
      }
      jsonlCount++;
    } catch (e) { /* skip */ }
  }
}

// Summary
console.log(`\n${'='.repeat(50)}`);
console.log(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);

if (failures.length > 0) {
  console.log(`\nWarnings:\n`);
  for (const f of failures) {
    console.log(`  [${f.schemaName}] ${f.filePath}`);
    for (const err of f.errors.slice(0, 3)) {
      console.log(`    ${err.instancePath || '/'}: ${err.message}`);
    }
  }
} else {
  console.log('\nAll files match expected schemas.');
}
