'use strict';

// Launch a GUI editor without ever handing a string to a shell.
//
// The naive fix for command injection here — dropping `shell: true` — does not
// work on Windows, and fails in two different ways:
//
//   * `spawn('code', args)` throws ENOENT, because the launcher on PATH is
//     `code.cmd` and Node does not consult PATHEXT.
//   * Resolving to `code.cmd` and spawning that throws EINVAL, because since the
//     CVE-2024-27980 fix (Node 18.20.2 / 20.12.2 / 21.7.3+) a .bat/.cmd target
//     may only be spawned with `shell: true` — the very thing we are removing.
//
// So on Windows we resolve the real .exe sitting behind the .cmd shim and spawn
// that directly. Only when no such .exe exists (npm-style shims, which are node
// scripts with no binary twin) do we fall back to cmd.exe, and that path applies
// a character allowlist so the quoting cannot be broken out of.
//
// CANONICAL COPY: scripts/security-lib/open-editor.js in the claude-code-hub repo.
// Duplicated verbatim into cck/, marketplace/ and memory/ — they are independent
// npm packages and cannot import from each other. Run scripts/sync-security-lib.sh
// after editing.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const IS_WIN = process.platform === 'win32';

// Editors whose CLI understands `-n` (open in a new window). Passing it to
// vim/nano/emacs would be wrong, so it is only injected for this family.
const VSCODE_FAMILY = new Set([
  'code', 'code-insiders', 'codium', 'vscodium', 'cursor', 'windsurf', 'positron', 'trae',
]);

// Characters that survive cmd.exe's double quotes and would let an argument
// escape it. Inside "..." cmd treats & | < > ^ ( ) as literal, so only these
// matter: '"' ends the quoted run, '%' triggers variable expansion whose value
// could itself contain a quote. Neither is legal in an NTFS path anyway.
const WIN_CMD_FORBIDDEN = /["%\r\n\u0000]/;

function fail(message, status) {
  return Object.assign(new Error(message), { status });
}

// Split an EDITOR value into argv. Handles `EDITOR="code -w"` and quoted paths
// such as `"C:\Program Files\App\app.exe" --flag`. No expansion, no globbing —
// EDITOR is operator-supplied, not request-supplied.
function splitCommandLine(str) {
  if (typeof str !== 'string') return []; // String(undefined) would yield an "undefined" argv entry
  const out = [];
  let cur = '';
  let quote = null;
  let quoted = false;
  for (const ch of String(str)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || quoted) { out.push(cur); cur = ''; quoted = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

// The PATH walk below stats PATH.length × PATHEXT.length candidates — on a
// typical Windows box ~1200 stats, several milliseconds. The answer cannot change
// within a process unless PATH itself does, so it is memoized on both.
const whichCache = new Map();

// which(1). On Windows this walks PATHEXT so we learn the resolved extension —
// that .cmd-vs-.exe distinction is what selects the launch strategy below.
function whichSync(cmd) {
  if (!cmd) return null;
  if (cmd.includes('/') || cmd.includes('\\')) {
    const abs = path.resolve(cmd);
    try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
  }
  const key = `${process.env.PATH || ''}\u0000${process.env.PATHEXT || ''}\u0000${cmd}`;
  if (whichCache.has(key)) return whichCache.get(key);
  const found = whichUncached(cmd);
  whichCache.set(key, found);
  return found;
}

function whichUncached(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
    }
  }
  return null;
}

// A GUI editor's .cmd shim normally lives at <install>/bin/foo.cmd next to
// <install>/Foo.exe. Returns that .exe so we can skip the shell entirely.
// npm-installed shims have no such twin and correctly return null here.
function exeBehindShim(shimPath) {
  const bin = path.dirname(shimPath);
  const root = path.dirname(bin);
  const stem = path.basename(shimPath, path.extname(shimPath));
  const candidates = [
    path.join(root, `${stem}.exe`),
    path.join(bin, `${stem}.exe`),
    path.join(root, 'Code.exe'),
    path.join(root, 'Cursor.exe'),
    path.join(root, 'Windsurf.exe'),
    path.join(root, 'VSCodium.exe'),
    path.join(root, 'Positron.exe'),
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

function launchViaCmd(exe, args) {
  for (const arg of [exe, ...args]) {
    if (WIN_CMD_FORBIDDEN.test(arg)) {
      throw fail('Path contains a character that cannot be passed safely to this editor', 400);
    }
  }
  const line = [exe, ...args].map((a) => `"${a}"`).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    windowsVerbatimArguments: true,
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  });
}

let cachedEditor;

function resolveEditor() {
  const spec = (process.env.EDITOR || '').trim() || 'code';
  if (cachedEditor && cachedEditor.spec === spec) return cachedEditor;
  const parts = splitCommandLine(spec);
  const cmd = parts[0];
  if (!cmd) throw fail('No editor configured (set EDITOR)', 500);
  const resolved = whichSync(cmd);
  if (!resolved) throw fail(`Editor not found on PATH: ${cmd}`, 500);
  cachedEditor = { spec, resolved, preArgs: parts.slice(1) };
  return cachedEditor;
}

/**
 * Validate a request-supplied path before it becomes an editor argument, and
 * return its resolved absolute form. Lives here rather than in each server so the
 * rule cannot drift between the apps that share this helper.
 *
 * Deliberately not a containment check: opening an arbitrary project directory is
 * the feature these endpoints exist for. The network boundary is the control.
 *
 * @param {unknown} value
 * @param {string} label used in the error message
 * @returns {string} resolved absolute path
 */
function assertOpenTarget(value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${label} must be a non-empty string`, 400);
  if (/[\r\n\u0000]/.test(value)) throw fail(`${label} contains invalid characters`, 400);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw fail(`${label} does not exist`, 404);
  return resolved;
}

/**
 * Open one or more already-validated absolute paths in the user's editor.
 * @param {string[]} targets
 * @param {{newWindow?: boolean}} [opts]
 */
function openInEditor(targets, opts = {}) {
  const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
  if (!list.length) throw fail('Nothing to open', 400);

  const { resolved, preArgs } = resolveEditor();
  const stem = path.basename(resolved, path.extname(resolved)).toLowerCase();

  const flags = [...preArgs];
  if (opts.newWindow !== false && VSCODE_FAMILY.has(stem) && !flags.includes('-n')) {
    flags.unshift('-n');
  }
  const argv = [...flags, ...list];

  const ext = path.extname(resolved).toLowerCase();
  if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
    const exe = exeBehindShim(resolved);
    if (exe) return spawn(exe, argv, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
    return launchViaCmd(resolved, argv).unref();
  }

  return spawn(resolved, argv, { stdio: 'ignore', detached: true }).unref();
}

/**
 * Run a command without a shell and capture its output. Same Windows .cmd
 * strategy as openInEditor: prefer the real .exe, fall back to an explicitly
 * quoted cmd.exe line guarded by the character allowlist. Callers must still
 * validate every argument — this stops shell metacharacters, not bad flags.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function execNoShell(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const resolved = whichSync(cmd);
    if (!resolved) return reject(fail(`Command not found on PATH: ${cmd}`, 500));

    let file = resolved;
    let argv = args;
    const spawnOpts = {
      cwd: opts.cwd || undefined,
      env: opts.env,
      timeout: opts.timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const ext = path.extname(resolved).toLowerCase();
    if (IS_WIN && (ext === '.cmd' || ext === '.bat')) {
      const exe = exeBehindShim(resolved);
      if (exe) {
        file = exe;
      } else {
        for (const arg of [resolved, ...args]) {
          if (WIN_CMD_FORBIDDEN.test(String(arg))) {
            return reject(fail('Argument contains a character that cannot be passed safely', 400));
          }
        }
        const line = [resolved, ...args].map((a) => `"${a}"`).join(' ');
        file = process.env.ComSpec || 'cmd.exe';
        argv = ['/d', '/s', '/c', `"${line}"`];
        spawnOpts.windowsVerbatimArguments = true;
      }
    }

    let child;
    try {
      child = spawn(file, argv, spawnOpts);
    } catch (err) {
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) return reject(new Error(`Command terminated by ${signal}: ${stderr.trim()}`));
      if (code !== 0) return reject(new Error(stderr.trim() || `Command exited with code ${code}`));
      resolve({ stdout, stderr });
    });
  });
}

module.exports = { assertOpenTarget, openInEditor, execNoShell, whichSync, splitCommandLine, exeBehindShim };
