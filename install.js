#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const HOOK_SCRIPT_DEST = path.join(HOOKS_DIR, 'agent-spy.sh');
const HOOK_SCRIPT_SRC = path.join(__dirname, 'hooks', 'agent-spy.sh');
const AGENT_ACTIVITY_DIR = path.join(CLAUDE_DIR, 'agent-activity');

const HOOK_COMMAND = '~/.claude/hooks/agent-spy.sh';
const HOOK_EVENTS = ['SubagentStart', 'SubagentStop', 'TeammateIdle'];

// ANSI helpers
const green = s => `\x1b[32m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const red = s => `\x1b[31m${s}\x1b[0m`;
const bold = s => `\x1b[1m${s}\x1b[0m`;
const dim = s => `\x1b[2m${s}\x1b[0m`;

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(!answer || answer.trim().toLowerCase() !== 'n');
    });
  });
}

async function runInstall() {
  console.log(`\n  ${bold('claude-code-kanban')} — Agent Log hook installer\n`);

  // 1. Check jq
  process.stdout.write('  Checking jq... ');
  try {
    const ver = execSync('jq --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    console.log(green(`✓ found (${ver})`));
  } catch {
    console.log(yellow('⚠ not found — hook script requires jq for JSON parsing'));
  }

  // 2. Hook script
  console.log(`\n  Hook script: ${dim(HOOK_SCRIPT_DEST)}`);
  let hookInstalled = false;
  if (fs.existsSync(HOOK_SCRIPT_DEST)) {
    const existing = fs.readFileSync(HOOK_SCRIPT_DEST, 'utf8');
    const bundled = fs.readFileSync(HOOK_SCRIPT_SRC, 'utf8');
    if (existing === bundled) {
      console.log(`    ${green('✓')} Up to date`);
      hookInstalled = true;
    } else {
      if (await prompt(`    Different version found. Update? [Y/n] `)) {
        fs.mkdirSync(HOOKS_DIR, { recursive: true });
        fs.copyFileSync(HOOK_SCRIPT_SRC, HOOK_SCRIPT_DEST);
        try { fs.chmodSync(HOOK_SCRIPT_DEST, 0o755); } catch {}
        console.log(`    ${green('✓')} Updated`);
        hookInstalled = true;
      } else {
        console.log(`    ${dim('Skipped')}`);
      }
    }
  } else {
    if (await prompt(`    Not found. Install? [Y/n] `)) {
      fs.mkdirSync(HOOKS_DIR, { recursive: true });
      fs.copyFileSync(HOOK_SCRIPT_SRC, HOOK_SCRIPT_DEST);
      try { fs.chmodSync(HOOK_SCRIPT_DEST, 0o755); } catch {}
      console.log(`    ${green('✓')} Installed and set executable`);
      hookInstalled = true;
    } else {
      console.log(`    ${dim('Skipped')}`);
    }
  }

  // 3. Settings.json
  console.log(`\n  Settings: ${dim(SETTINGS_PATH)}`);
  let settings;
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } else {
      settings = {};
    }
  } catch (e) {
    console.log(`    ${red('✗')} Malformed JSON in settings.json — aborting settings update`);
    printSummary(hookInstalled, false);
    return;
  }

  if (!settings.hooks) settings.hooks = {};

  const needed = [];
  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];
    const exists = settings.hooks[event].some(g =>
      g.hooks?.some(h => h.command === HOOK_COMMAND)
    );
    if (!exists) needed.push(event);
  }

  let settingsUpdated = false;
  if (needed.length === 0) {
    console.log(`    ${green('✓')} Already configured`);
    settingsUpdated = true;
  } else {
    console.log(`    Adding hooks for: ${needed.join(', ')}`);
    if (await prompt(`    Update settings? [Y/n] `)) {
      for (const event of needed) {
        settings.hooks[event].push({
          matcher: '',
          hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }]
        });
      }
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
      console.log(`    ${green('✓')} ${needed.length} hook entries added`);
      settingsUpdated = true;
    } else {
      console.log(`    ${dim('Skipped')}`);
    }
  }

  printSummary(hookInstalled, settingsUpdated);
}

function printSummary(hookOk, settingsOk) {
  console.log('');
  if (hookOk && settingsOk) {
    console.log(`  ${green('Agent Log will appear in the Kanban footer when subagents are active.')}`);
  } else {
    console.log(`  ${yellow('Partial install — re-run --install to complete setup.')}`);
  }
  console.log('');
}

async function runUninstall() {
  console.log(`\n  ${bold('claude-code-kanban')} — Agent Log hook uninstaller\n`);

  // 1. Remove hook entries from settings.json
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      if (settings.hooks) {
        let removed = 0;
        for (const event of HOOK_EVENTS) {
          if (!Array.isArray(settings.hooks[event])) continue;
          const before = settings.hooks[event].length;
          settings.hooks[event] = settings.hooks[event].filter(g =>
            !g.hooks?.some(h => h.command === HOOK_COMMAND)
          );
          removed += before - settings.hooks[event].length;
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        console.log(`  Settings: ${green('✓')} Removed ${removed} hook entries`);
      } else {
        console.log(`  Settings: ${dim('No hook entries found')}`);
      }
    } catch {
      console.log(`  Settings: ${red('✗')} Could not parse settings.json`);
    }
  } else {
    console.log(`  Settings: ${dim('No settings.json found')}`);
  }

  // 2. Remove hook script
  if (fs.existsSync(HOOK_SCRIPT_DEST)) {
    fs.unlinkSync(HOOK_SCRIPT_DEST);
    console.log(`  Hook script: ${green('✓')} Removed`);
  } else {
    console.log(`  Hook script: ${dim('Not found')}`);
  }

  // 3. Optionally remove agent-activity data
  if (fs.existsSync(AGENT_ACTIVITY_DIR)) {
    if (await prompt(`\n  Remove agent activity data (${AGENT_ACTIVITY_DIR})? [y/N] `)) {
      fs.rmSync(AGENT_ACTIVITY_DIR, { recursive: true, force: true });
      console.log(`  ${green('✓')} Agent activity data removed`);
    } else {
      console.log(`  ${dim('Kept agent activity data')}`);
    }
  }

  console.log(`\n  ${green('Uninstall complete.')}\n`);
}

module.exports = { runInstall, runUninstall };
