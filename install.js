#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execSync } = require('child_process');
const { getClaudeDir, claudeCliEnv, displayPath } = require('./lib/claude-dir');

const CLAUDE_DIR = getClaudeDir();
const CLI_ENV = claudeCliEnv(CLAUDE_DIR);
const CCK_DIR = path.join(CLAUDE_DIR, '.cck');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const PLUGIN_SRC = path.join(__dirname, 'plugin');
const PLUGIN_DEST = path.join(CCK_DIR, 'plugin');
const CTX_SCRIPT_NAME = 'context-status.sh';
const CTX_SCRIPT_SRC = path.join(PLUGIN_SRC, 'plugins', 'claude-code-kanban', 'scripts', CTX_SCRIPT_NAME);
const CTX_SCRIPT_DEST = path.join(HOOKS_DIR, CTX_SCRIPT_NAME);
const CTX_COMMAND = displayPath(CTX_SCRIPT_DEST);

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

function runCLI(cmd, okPatterns = []) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: CLI_ENV }).trim();
    return { ok: true, output: out };
  } catch (e) {
    const stderr = e.stderr?.trim() || e.message;
    if (okPatterns.some(p => stderr.includes(p))) return { ok: true, idempotent: true };
    return { ok: false, error: stderr };
  }
}

function copyScript(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  try { fs.chmodSync(dest, 0o755); } catch {}
}

// Deletes files but never directories: on Windows the running Claude Code process holds
// handles on the registered marketplace dirs, so removing one fails EPERM mid-clean and
// leaves the install gutted. Clearing files alone still drops anything stale, and the
// leftover empty dirs are harmless — copyDirSync writes straight back into them.
function clearFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) clearFilesRecursive(target);
    else fs.rmSync(target, { force: true });
  }
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      try { fs.chmodSync(destPath, 0o755); } catch {}
    }
  }
}

async function runInstall({ pluginOnly = false } = {}) {
  console.log(`\n  ${bold('claude-code-kanban')} — ${pluginOnly ? 'Plugin installer' : 'Plugin & StatusLine installer'}\n`);
  console.log(`  Claude config dir: ${dim(displayPath(CLAUDE_DIR))}\n`);
  let failed = false;

  // 1. Check prerequisites
  process.stdout.write('  Checking claude CLI... ');
  const claude = runCLI('claude --version');
  if (claude.ok) {
    console.log(green(`✓ found (${claude.output})`));
  } else {
    console.log(red('✗ claude CLI not found'));
    console.log(`    ${dim('Install Claude Code CLI first: https://docs.anthropic.com/en/docs/claude-code')}`);
    return;
  }

  process.stdout.write('  Checking jq... ');
  const jq = runCLI('jq --version');
  if (jq.ok) {
    console.log(green(`✓ found (${jq.output})`));
  } else {
    console.log(yellow('⚠ not found — hook scripts require jq for JSON parsing'));
  }

  // 2. Copy plugin to stable location & register marketplace
  console.log(`\n  Plugin: ${dim(PLUGIN_DEST)}`);
  if (pluginOnly || await prompt(`    Install claude-code-kanban plugin? [Y/n] `)) {
    process.stdout.write(`    Copying plugin to ${displayPath(PLUGIN_DEST)}... `);
    try {
      clearFilesRecursive(PLUGIN_DEST);
      copyDirSync(PLUGIN_SRC, PLUGIN_DEST);
      console.log(green('✓'));
    } catch (e) {
      console.log(red(`✗ ${e.message}`));
      failed = true;
    }

    process.stdout.write('    Registering marketplace... ');
    const mkt = runCLI(`claude plugin marketplace add "${PLUGIN_DEST}"`, ['already', 'exists']);
    if (mkt.ok) {
      console.log(green(mkt.idempotent ? '✓ already registered' : '✓'));
    } else {
      console.log(yellow(`⚠ ${mkt.error}`));
    }

    // Claude caches the marketplace manifest, so a re-copied plugin stays invisible until refreshed
    const upd = runCLI('claude plugin marketplace update claude-code-kanban');
    if (!upd.ok) console.log(`    ${yellow('⚠')} Marketplace refresh failed: ${upd.error}`);

    const inst = runCLI('claude plugin install claude-code-kanban@claude-code-kanban', ['already installed', 'already exists']);
    if (inst.ok) {
      console.log(`    ${green('✓')} ${inst.idempotent ? 'Already installed' : 'Plugin installed'}`);
    } else {
      console.log(`    ${red('✗')} Plugin install failed: ${inst.error}`);
      failed = true;
    }
  } else {
    console.log(`    ${dim('Skipped')}`);
  }

  if (pluginOnly) {
    console.log(`\n  ${dim('Context spy and statusline skipped (--plugin-only).')}`);
    printSummary(failed);
    return;
  }

  // 3. StatusLine setup (context-status.sh must be copied globally since statusLine is not plugin-scoped)
  console.log(`\n  Context spy: ${dim(CTX_SCRIPT_DEST)}`);
  let ctxInstalled = false;
  if (fs.existsSync(CTX_SCRIPT_DEST)) {
    const existing = fs.readFileSync(CTX_SCRIPT_DEST, 'utf8');
    const bundled = fs.readFileSync(CTX_SCRIPT_SRC, 'utf8');
    if (existing === bundled) {
      console.log(`    ${green('✓')} Up to date`);
      ctxInstalled = true;
    } else if (await prompt(`    Different version found. Update? [Y/n] `)) {
      copyScript(CTX_SCRIPT_SRC, CTX_SCRIPT_DEST);
      console.log(`    ${green('✓')} Updated`);
      ctxInstalled = true;
    } else {
      console.log(`    ${dim('Skipped')}`);
    }
  } else if (await prompt(`    Not found. Install? [Y/n] `)) {
    copyScript(CTX_SCRIPT_SRC, CTX_SCRIPT_DEST);
    console.log(`    ${green('✓')} Installed`);
    ctxInstalled = true;
  } else {
    console.log(`    ${dim('Skipped')}`);
  }

  // 4. StatusLine config in settings.json
  if (ctxInstalled) {
    let settings;
    try {
      settings = fs.existsSync(SETTINGS_PATH)
        ? JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
        : {};
    } catch {
      console.log(`    ${red('✗')} Malformed JSON in settings.json — skipping statusline config`);
      printSummary(true);
      return;
    }

    const hasCtx = settings.statusLine?.command?.includes(CTX_SCRIPT_NAME);
    if (hasCtx) {
      console.log(`\n  StatusLine: ${green('✓')} Already configured`);
    } else if (!settings.statusLine) {
      console.log(`\n  StatusLine: ${dim('not configured')}`);
      if (await prompt(`    Set up context tracking statusline? [Y/n] `)) {
        settings.statusLine = { type: 'command', command: CTX_COMMAND };
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        console.log(`    ${green('✓')} StatusLine configured`);
      } else {
        console.log(`    ${dim('Skipped')}`);
      }
    } else {
      const existing = settings.statusLine.command;
      console.log(`\n  StatusLine: ${dim(`current: ${existing}`)}`);
      if (await prompt(`    Prepend context spy to existing statusline? [Y/n] `)) {
        settings.statusLine.type = 'command';
        settings.statusLine.command = `${CTX_COMMAND} | ${existing}`;
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        console.log(`    ${green('✓')} StatusLine updated`);
      } else {
        console.log(`    ${dim('Skipped')}`);
      }
    }
  }

  printSummary(failed);
}

function printSummary(failed = false) {
  if (failed) {
    console.log(`\n  ${red('Setup incomplete — see the errors above.')}\n`);
    return;
  }
  console.log(`\n  ${green('Setup complete. Agent activity will appear in the Kanban dashboard.')}\n`);
}

async function runUninstall() {
  console.log(`\n  ${bold('claude-code-kanban')} — Uninstaller\n`);
  console.log(`  Claude config dir: ${dim(displayPath(CLAUDE_DIR))}\n`);

  // 1. Uninstall plugin via Claude CLI
  process.stdout.write('  Removing plugin... ');
  const uninst = runCLI('claude plugin uninstall claude-code-kanban', ['not found', 'not installed']);
  if (uninst.ok) {
    console.log(uninst.idempotent ? dim('Not installed') : green('✓ Removed'));
  } else {
    console.log(yellow(`⚠ ${uninst.error}`));
  }

  // 2. Remove marketplace
  process.stdout.write('  Removing marketplace... ');
  const rmMkt = runCLI('claude plugin marketplace remove claude-code-kanban', ['not found', 'not configured']);
  if (rmMkt.ok) {
    console.log(rmMkt.idempotent ? dim('Not configured') : green('✓ Removed'));
  } else {
    console.log(yellow(`⚠ ${rmMkt.error}`));
  }

  // 3. Remove plugin copy
  if (fs.existsSync(PLUGIN_DEST)) {
    fs.rmSync(PLUGIN_DEST, { recursive: true, force: true });
    console.log(`  Plugin copy: ${green('✓')} Removed`);
  } else {
    console.log(`  Plugin copy: ${dim('Not found')}`);
  }

  // 4. Remove context-status.sh copy
  if (fs.existsSync(CTX_SCRIPT_DEST)) {
    fs.unlinkSync(CTX_SCRIPT_DEST);
    console.log(`  Context spy: ${green('✓')} Removed`);
  } else {
    console.log(`  Context spy: ${dim('Not found')}`);
  }

  // 5. Clean up settings.json (statusLine)
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      let changed = false;

      // Strip context-status.sh from statusLine
      if (settings.statusLine?.command?.includes(CTX_SCRIPT_NAME)) {
        const cmd = settings.statusLine.command;
        const stripped = cmd.replace(new RegExp(`\\S*${CTX_SCRIPT_NAME.replace('.', '\\.')}\\s*\\|\\s*`), '').trim();
        if (stripped && stripped !== cmd) {
          settings.statusLine.command = stripped;
          console.log(`  StatusLine: ${green('✓')} Restored to "${stripped}"`);
        } else {
          delete settings.statusLine;
          console.log(`  StatusLine: ${green('✓')} Removed`);
        }
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
      }
    } catch {
      console.log(`  Settings: ${red('✗')} Could not parse settings.json`);
    }
  }

  console.log(`\n  ${green('Uninstall complete.')}\n`);
}

module.exports = { runInstall, runUninstall };
