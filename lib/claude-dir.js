const os = require('node:os');
const path = require('node:path');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude');

// --name <value> | --name=<value>; null when absent.
function getArgValue(name) {
  const argv = process.argv;
  const idx = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = argv[idx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return argv[idx + 1] || null;
}

function expandHome(dir) {
  return dir.replace(/^~/, os.homedir());
}

// --dir | CLAUDE_CONFIG_DIR | CLAUDE_DIR | ~/.claude
function getClaudeDir() {
  const dir = getArgValue('dir') || process.env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_DIR;
  return dir ? expandHome(dir) : DEFAULT_CLAUDE_DIR;
}

function isDefaultClaudeDir(dir) {
  return path.resolve(dir) === path.resolve(DEFAULT_CLAUDE_DIR);
}

// Env for spawning the claude CLI. Claude Code keeps .claude.json beside ~/.claude when
// CLAUDE_CONFIG_DIR is unset but inside the dir when it is set, so the default dir must
// stay unset rather than be spelled out.
function claudeCliEnv(dir) {
  return isDefaultClaudeDir(dir) ? process.env : { ...process.env, CLAUDE_CONFIG_DIR: dir };
}

// Home-relative, forward-slash form for messages and shell commands.
function displayPath(p) {
  const home = os.homedir();
  const rel = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  return rel.split(path.sep).join('/');
}

module.exports = { getArgValue, getClaudeDir, claudeCliEnv, displayPath };
