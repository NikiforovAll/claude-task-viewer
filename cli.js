const path = require('path');

// Help is auto-generated from this table — keep flags/usage in sync with `run` behavior.
const COMMANDS = {
  'preview-doc': {
    summary: 'Open a markdown or HTML file in the preview modal on connected browser tabs',
    usage: 'claude-code-kanban preview-doc <file.md|file.html> [--session <id>]',
    flags: {
      '--session <id>': 'Switch focused session in the browser (does not link the file)',
    },
    run: runPreviewCli,
  },
  'link-doc': {
    summary: 'Link a file to a session in the sidebar without opening the preview modal',
    usage: 'claude-code-kanban link-doc <file> --session <id> [--unlink]',
    flags: {
      '--session <id>': 'Session to link the file to (required unless $PREVIEW_SESSION is set)',
      '--unlink': 'Remove the link instead of adding it',
    },
    run: runLinkDocCli,
  },
  session: {
    summary: 'List or open Claude Code sessions',
    verbs: {
      list: {
        summary: 'List sessions (pinned/sticky always included)',
        usage: 'claude-code-kanban session list [--active] [--days <n>] [--project <name>] [--limit <n|all>] [--no-pins] [--json]',
        flags: {
          '--active': 'Only sessions with recent activity (sidebar-style filter)',
          '--days <n>': 'Only sessions modified within the last N days (fractional ok, e.g. 0.5)',
          '--project <name>': 'Filter by project name (substring match)',
          '--limit <n|all>': 'Max rows to display (default: 10). Use "all" for no cap.',
          '--no-pins': 'Disable always-include and sticky-first ordering for pinned sessions',
          '--json': 'Output JSON instead of a table',
        },
        run: runSessionListCli,
      },
      open: {
        summary: 'Focus a session in the browser (Active tab)',
        usage: 'claude-code-kanban session open <id>',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
        },
        run: runSessionOpenCli,
      },
      view: {
        summary: 'Show full session stats (metadata + context window + cost)',
        usage: 'claude-code-kanban session view <id> [--json]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--json': 'Output JSON instead of formatted sections',
        },
        run: runSessionViewCli,
      },
      pin: {
        summary: 'Pin (or unpin) a session in the sidebar of connected browser tabs',
        usage: 'claude-code-kanban session pin <id> [--sticky] [--unpin]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--sticky': 'Set sticky state (always shown, top of list)',
          '--unpin': 'Clear pin/sticky state',
        },
        run: runSessionPinCli,
      },
      pins: {
        summary: 'List sessions pinned/stickied via the dashboard or CLI',
        usage: 'claude-code-kanban session pins [--sticky] [--json]',
        flags: {
          '--sticky': 'Only sessions in sticky state',
          '--json': 'Output JSON instead of a table',
        },
        run: runSessionPinsCli,
      },
      peek: {
        summary: 'Show the last N messages from a session',
        usage: 'claude-code-kanban session peek <id> [--limit <n>] [--json]',
        flags: {
          '<id>': 'Full session id, or a unique prefix',
          '--limit <n>': 'Number of messages (default: 10, max: 50)',
          '--json': 'Output JSON instead of formatted lines',
        },
        run: runSessionPeekCli,
      },
    },
  },
};

function runCli(argv) {
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(require('./package.json').version);
    process.exit(0);
  }
  const cli = resolveCliCommand(argv);
  if (cli.kind === 'server') return false;
  if (cli.kind === 'help') {
    if (cli.target && Object.hasOwn(COMMANDS, cli.target)) printNounHelp(cli.target);
    else printTopHelp();
    process.exit(0);
  }
  if (cli.kind === 'unknown-noun') {
    console.error(`Unknown command: ${cli.noun}\n`);
    printTopHelp();
    process.exit(1);
  }
  if (cli.kind === 'unknown-verb') {
    console.error(`Unknown subcommand: ${cli.noun} ${cli.verb}\n`);
    printNounHelp(cli.noun);
    process.exit(1);
  }
  if (cli.kind === 'noun') {
    printNounHelp(cli.noun);
    process.exit(0);
  }
  if (cli.kind === 'leaf') {
    if (cli.args.includes('--help') || cli.args.includes('-h')) {
      printLeafHelp(cli.name, cli.entry);
      process.exit(0);
    }
    cli.entry.run(cli.args)
      .then(code => { process.exitCode = code; })
      .catch(e => { console.error(e.message); process.exitCode = 1; });
    return true;
  }
  return true;
}

function resolveCliCommand(argv) {
  const noun = argv[2] && !argv[2].startsWith('-') ? argv[2] : null;
  const hasHelp = (a) => a.includes('--help') || a.includes('-h');
  if (!noun) return hasHelp(argv) ? { kind: 'help' } : { kind: 'server' };
  if (noun === 'help') return { kind: 'help', target: argv[3] };
  if (!Object.hasOwn(COMMANDS, noun)) return { kind: 'unknown-noun', noun };
  const entry = COMMANDS[noun];
  if (!entry.verbs) return { kind: 'leaf', name: noun, entry, args: argv.slice(3) };
  const verb = argv[3] && !argv[3].startsWith('-') ? argv[3] : null;
  if (!verb) return { kind: 'noun', noun };
  if (!Object.hasOwn(entry.verbs, verb)) return { kind: 'unknown-verb', noun, verb };
  return { kind: 'leaf', name: `${noun} ${verb}`, entry: entry.verbs[verb], args: argv.slice(4) };
}

function printTopHelp() {
  console.log('Usage: claude-code-kanban <command> [args] [--flags]\n');
  console.log('Commands:');
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(20)}${cmd.summary}`);
    if (cmd.verbs) {
      for (const [vName, v] of Object.entries(cmd.verbs)) {
        console.log(`    ${`${name} ${vName}`.padEnd(18)}${v.summary}`);
      }
    }
  }
  console.log(`  ${'help'.padEnd(20)}Show help for a command (claude-code-kanban help <command>)`);
  console.log('\nFlags:');
  console.log('  --help, -h            Show help (top-level, noun-level, or leaf-level)');
  console.log('  --version, -v         Print version and exit');
  console.log('\nServer mode (no subcommand):');
  console.log('  --port <n>            Port to listen on (default 3541)');
  console.log('  --dir <path>          Override Claude config dir (default ~/.claude); also targets --install/--uninstall');
  console.log('  --open                Open browser on start');
  console.log('  --install, --uninstall    Install or remove the plugin, context spy, and statusline');
  console.log('  --plugin-only         With --install: refresh only the plugin, skip context spy and statusline');
}

function printNounHelp(noun) {
  const entry = COMMANDS[noun];
  console.log(`${entry.summary}\n`);
  if (entry.verbs) {
    console.log(`Usage: claude-code-kanban ${noun} <subcommand> [args] [--flags]\n`);
    console.log('Subcommands:');
    for (const [vName, v] of Object.entries(entry.verbs)) {
      console.log(`  ${vName.padEnd(12)}${v.summary}`);
    }
    console.log(`\nRun \`claude-code-kanban ${noun} <subcommand> --help\` for details.`);
  } else {
    printLeafHelp(noun, entry);
  }
}

function printLeafHelp(name, entry) {
  console.log(`${entry.summary}\n`);
  console.log(`Usage: ${entry.usage}`);
  if (entry.flags && Object.keys(entry.flags).length) {
    const pad = Math.max(...Object.keys(entry.flags).map(f => f.length));
    console.log('\nFlags:');
    for (const [flag, desc] of Object.entries(entry.flags)) {
      console.log(`  ${flag.padEnd(pad + 2)}${desc}`);
    }
  }
  console.log('\n  --help, -h            Show this help');
}

function getArgValue(args, name) {
  const idx = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (idx === -1) return null;
  const arg = args[idx];
  if (arg.includes('=')) return arg.split('=').slice(1).join('=');
  return args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : null;
}

function cliPort() { return process.env.PORT || 3541; }
function unreachable() { return `Cannot reach cck server on port ${cliPort()}. Start it first with "claude-code-kanban".`; }

class CliUnreachable extends Error { constructor() { super(unreachable()); this.code = 'unreachable'; } }

async function cliFetch(urlPath, init) {
  try {
    return await fetch(`http://127.0.0.1:${cliPort()}${urlPath}`, init);
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(e.message)) throw new CliUnreachable();
    throw e;
  }
}

// Every write verb posts JSON and reports failure the same way; `label` names the verb
// in the error line. Returns false when the server refused, so callers just return 1.
async function cliPostJson(urlPath, body, label) {
  const res = await cliFetch(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) return true;
  console.error(`${label} failed (${res.status}): ${await res.text()}`);
  return false;
}

function reportCliError(e) {
  console.error(e.code === 'unreachable' ? e.message : (e.message || String(e)));
}

async function runPreviewCli(args) {
  const filePathArg = args.find(a => !a.startsWith('--'));
  if (!filePathArg) {
    printLeafHelp('preview-doc', COMMANDS['preview-doc']);
    return 1;
  }
  const sessionId = getArgValue(args, 'session') || process.env.PREVIEW_SESSION || null;
  const abs = path.resolve(filePathArg);
  try {
    if (!await cliPostJson('/api/preview', { path: abs, sessionId }, 'Preview')) return 1;
    console.log(`Preview opened: ${abs}${sessionId ? ` (session ${sessionId})` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runLinkDocCli(args) {
  const filePathArg = args.find(a => !a.startsWith('--'));
  const sessionArg = getArgValue(args, 'session') || process.env.PREVIEW_SESSION || null;
  if (!filePathArg) {
    printLeafHelp('link-doc', COMMANDS['link-doc']);
    return 1;
  }
  if (!sessionArg) {
    console.error('--session is required: linked docs are stored per session.');
    return 1;
  }
  const unlink = args.includes('--unlink');
  // Resolved here because the browser keys linked docs by full id, so a prefix won't match.
  const resolved = await resolveSessionByIdOrPrefix(sessionArg);
  if (!resolved) return 1;
  const abs = path.resolve(filePathArg);
  try {
    if (!await cliPostJson('/api/document/link', { path: abs, sessionId: resolved.id, unlink }, 'Link')) return 1;
    console.log(`Document ${unlink ? 'unlinked from' : 'linked to'} session ${resolved.id.slice(0, 8)}: ${abs}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

// Mirror of `isSessionActive` in public/app.js — keep in sync (different runtimes, no shared module).
function isSessionActive(s) {
  return s.hasRecentLog || s.inProgress > 0 || s.hasActiveAgents || s.hasWaitingForUser;
}

function sessionStatus(s) {
  if (!isSessionActive(s)) return 'idle';
  if (s.hasWaitingForUser) return 'wait';
  if (s.inProgress > 0) return 'busy';
  return 'active';
}

function parseLimit(args, { fallback, allowAll = false }) {
  const raw = getArgValue(args, 'limit');
  if (raw === null) return { ok: true, limit: fallback };
  if (allowAll && raw === 'all') return { ok: true, limit: null };
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) return { ok: false, error: `Invalid --limit value: ${raw}` };
  return { ok: true, limit: n };
}

async function fetchSessionsList(limit, pinnedIds = []) {
  const q = limit === null ? 'all' : String(limit);
  const pinnedQ = pinnedIds.length ? `&pinned=${pinnedIds.join(',')}` : '';
  const res = await cliFetch(`/api/sessions?limit=${q}${pinnedQ}`);
  if (!res.ok) throw new Error(`Failed to fetch sessions (${res.status})`);
  return res.json();
}

async function fetchPinsMap() {
  try {
    const res = await cliFetch('/api/session/pins');
    if (!res.ok) return {};
    const { pins = {} } = await res.json();
    return pins;
  } catch { return {}; }
}

async function resolveSessionByIdOrPrefix(idArg) {
  let res;
  try {
    res = await cliFetch(`/api/session/resolve?id=${encodeURIComponent(idArg)}`);
  } catch (e) {
    reportCliError(e);
    return null;
  }
  if (res.status === 404) {
    console.error(`No session matches: ${idArg}`);
    return null;
  }
  if (res.status === 409) {
    const { matches = [] } = await res.json().catch(() => ({}));
    console.error(`Ambiguous prefix "${idArg}" matches ${matches.length} sessions:`);
    for (const m of matches.slice(0, 10)) console.error(`  ${m.id}  ${m.customTitle || ''}`);
    return null;
  }
  if (!res.ok) {
    console.error(`Resolve failed (${res.status}): ${await res.text()}`);
    return null;
  }
  return res.json();
}

async function runSessionListCli(args) {
  const activeOnly = args.includes('--active');
  const noPins = args.includes('--no-pins');
  const projectFilter = getArgValue(args, 'project');
  const daysArg = getArgValue(args, 'days');
  const days = daysArg !== null ? parseFloat(daysArg) : null;
  if (daysArg !== null && (Number.isNaN(days) || days <= 0)) {
    console.error(`Invalid --days value: ${daysArg}`);
    return 1;
  }
  const parsed = parseLimit(args, { fallback: 10, allowAll: true });
  if (!parsed.ok) { console.error(parsed.error); return 1; }
  const limit = parsed.limit;
  const asJson = args.includes('--json');
  const pinsMap = noPins ? {} : await fetchPinsMap();
  const pinnedIds = Object.keys(pinsMap);
  const hasClientFilter = activeOnly || days !== null || projectFilter;
  let list;
  try {
    list = await fetchSessionsList(hasClientFilter ? null : limit, pinnedIds);
  } catch (e) {
    reportCliError(e);
    return 1;
  }
  const pinOf = id => pinsMap[id] || null;
  if (activeOnly) list = list.filter(s => pinOf(s.id) || isSessionActive(s));
  if (days !== null) {
    const cutoff = Date.now() - days * 86_400_000;
    list = list.filter(s => pinOf(s.id) || (s.modifiedAt && new Date(s.modifiedAt).getTime() >= cutoff));
  }
  if (projectFilter) {
    const needle = projectFilter.toLowerCase();
    list = list.filter(s => (s.project || '').toLowerCase().includes(needle));
  }
  const pinRank = id => pinOf(id) === 'sticky' ? 0 : pinOf(id) === 'pinned' ? 1 : 2;
  list.sort((a, b) => {
    const r = pinRank(a.id) - pinRank(b.id);
    if (r !== 0) return r;
    return new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0);
  });
  if (limit !== null && list.length > limit) {
    const top = list.slice(0, limit);
    const topIds = new Set(top.map(s => s.id));
    const extraPinned = list.filter(s => pinOf(s.id) && !topIds.has(s.id));
    list = [...top, ...extraPinned];
  }
  if (asJson) {
    console.log(JSON.stringify(list.map(s => ({ ...s, pinState: pinOf(s.id) })), null, 2));
    return 0;
  }
  if (!list.length) {
    console.log('No sessions match.');
    return 0;
  }
  const rows = list.map(s => ({
    id: s.id.slice(0, 8),
    pin: pinOf(s.id) || '',
    status: sessionStatus(s),
    age: s.modifiedAt ? formatAge(Date.now() - new Date(s.modifiedAt).getTime()) : '-',
    tasks: `${s.completed}/${s.taskCount}`,
    project: path.basename(s.project || ''),
    title: s.customTitle || s.name || s.slug || '',
  }));
  const w = {
    id: 8,
    pin: Math.max(3, ...rows.map(r => r.pin.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
    age: Math.max(3, ...rows.map(r => r.age.length)),
    tasks: Math.max(5, ...rows.map(r => r.tasks.length)),
    project: Math.max(7, ...rows.map(r => r.project.length)),
  };
  console.log(`${'ID'.padEnd(w.id)}  ${'PIN'.padEnd(w.pin)}  ${'STATUS'.padEnd(w.status)}  ${'AGE'.padEnd(w.age)}  ${'TASKS'.padEnd(w.tasks)}  ${'PROJECT'.padEnd(w.project)}  TITLE`);
  for (const r of rows) {
    console.log(`${r.id.padEnd(w.id)}  ${r.pin.padEnd(w.pin)}  ${r.status.padEnd(w.status)}  ${r.age.padEnd(w.age)}  ${r.tasks.padEnd(w.tasks)}  ${r.project.padEnd(w.project)}  ${r.title}`);
  }
  return 0;
}

function formatAge(ms) {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

async function runSessionOpenCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp('session open', COMMANDS.session.verbs.open);
    return 1;
  }
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    if (!await cliPostJson('/api/session/open', { id: resolved.id }, 'Open')) return 1;
    console.log(`Session opened: ${resolved.id}${resolved.customTitle ? ` (${resolved.customTitle})` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSessionPinCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp('session pin', COMMANDS.session.verbs.pin);
    return 1;
  }
  const state = args.includes('--unpin') ? 'none' : args.includes('--sticky') ? 'sticky' : 'pinned';
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    if (!await cliPostJson('/api/session/pin', { id: resolved.id, state }, 'Pin')) return 1;
    const label = state === 'none' ? 'unpinned' : state;
    console.log(`Session ${label}: ${resolved.id}${resolved.customTitle ? ` (${resolved.customTitle})` : ''}`);
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

async function runSessionPinsCli(args) {
  const stickyOnly = args.includes('--sticky');
  const asJson = args.includes('--json');
  const pinsMap = await fetchPinsMap();
  const items = Object.entries(pinsMap)
    .filter(([, state]) => !stickyOnly || state === 'sticky')
    .map(([id, state]) => ({ id, state }));
  if (!items.length) {
    if (asJson) console.log('[]'); else console.log('No pinned sessions.');
    return 0;
  }
  let sessions;
  try {
    sessions = await fetchSessionsList(items.length, items.map(p => p.id));
  } catch (e) { reportCliError(e); return 1; }
  const byId = new Map(sessions.map(s => [s.id, s]));
  let rows = items
    .map(p => {
      const s = byId.get(p.id) || {};
      return {
        id: p.id,
        state: p.state,
        status: s.id ? sessionStatus(s) : '-',
        age: s.modifiedAt ? formatAge(Date.now() - new Date(s.modifiedAt).getTime()) : '-',
        project: path.basename(s.project || ''),
        title: s.customTitle || s.name || s.slug || '',
      };
    })
    .sort((a, b) => (a.state === b.state ? 0 : a.state === 'sticky' ? -1 : 1));
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const w = {
    id: 8,
    state: Math.max(5, ...rows.map(r => r.state.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
    age: Math.max(3, ...rows.map(r => r.age.length)),
    project: Math.max(7, ...rows.map(r => r.project.length)),
  };
  console.log(`${'ID'.padEnd(w.id)}  ${'STATE'.padEnd(w.state)}  ${'STATUS'.padEnd(w.status)}  ${'AGE'.padEnd(w.age)}  ${'PROJECT'.padEnd(w.project)}  TITLE`);
  for (const r of rows) {
    console.log(`${r.id.slice(0, 8).padEnd(w.id)}  ${r.state.padEnd(w.state)}  ${r.status.padEnd(w.status)}  ${r.age.padEnd(w.age)}  ${r.project.padEnd(w.project)}  ${r.title}`);
  }
  return 0;
}

async function runSessionViewCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp('session view', COMMANDS.session.verbs.view);
    return 1;
  }
  const asJson = args.includes('--json');
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  let list;
  try {
    list = await fetchSessionsList(null);
  } catch (e) { reportCliError(e); return 1; }
  const s = list.find(x => x.id === resolved.id);
  if (!s) {
    console.error(`Session ${resolved.id} not found in /api/sessions response.`);
    return 1;
  }
  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  const status = sessionStatus(s);
  const title = s.customTitle || s.name || s.slug || '';
  const age = s.modifiedAt ? formatAge(Date.now() - new Date(s.modifiedAt).getTime()) : '-';
  const fmtTok = (n) => typeof n === 'number' ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)) : '-';
  const fmtCost = (n) => typeof n === 'number' ? `$${n.toFixed(2)}` : '-';
  const lines = [];
  lines.push(`${s.id.slice(0, 8)} — ${title} [${status}]`);
  if (s.project) lines.push(`  ${path.basename(s.project)}${s.gitBranch ? ` · ${s.gitBranch}` : ''} · modified ${age} ago`);
  lines.push(`  Tasks: ${s.completed}/${s.taskCount}${s.inProgress ? ` (${s.inProgress} in progress)` : ''}${s.pending ? ` · ${s.pending} pending` : ''}`);
  const ctx = s.contextStatus;
  if (ctx) {
    const cw = ctx.context_window || {};
    const cost = ctx.cost || {};
    const rl = ctx.rate_limits || {};
    const modelName = ctx.model?.display_name || ctx.model?.id || '-';
    const modelExtras = [
      ctx.effort?.level,
      ctx.thinking?.enabled ? 'thinking' : null,
      ctx.fast_mode ? 'fast' : null,
    ].filter(Boolean).join(' · ');
    lines.push(`  Model: ${modelName}${modelExtras ? ` (${modelExtras})` : ''}`);
    if (cw.used_percentage != null) {
      lines.push(`  Context: ${cw.used_percentage}% used · ${fmtTok(cw.total_input_tokens)} in / ${fmtTok(cw.total_output_tokens)} out · cache ${fmtTok(cw.current_usage?.cache_read_input_tokens)} read`);
    }
    lines.push(`  Cost: ${fmtCost(cost.total_cost_usd)} · ${cost.total_api_duration_ms != null ? formatAge(cost.total_api_duration_ms) : '-'} api / ${cost.total_duration_ms != null ? formatAge(cost.total_duration_ms) : '-'} total · +${cost.total_lines_added || 0}/-${cost.total_lines_removed || 0}`);
    if (rl.five_hour || rl.seven_day) {
      lines.push(`  Limits: 5h ${rl.five_hour?.used_percentage ?? '-'}% · 7d ${rl.seven_day?.used_percentage ?? '-'}%`);
    }
  }
  console.log(lines.join('\n'));
  return 0;
}

async function runSessionPeekCli(args) {
  const idArg = args.find(a => !a.startsWith('--'));
  if (!idArg) {
    printLeafHelp('session peek', COMMANDS.session.verbs.peek);
    return 1;
  }
  const parsed = parseLimit(args, { fallback: 10 });
  if (!parsed.ok) { console.error(parsed.error); return 1; }
  const limit = parsed.limit;
  const asJson = args.includes('--json');
  const resolved = await resolveSessionByIdOrPrefix(idArg);
  if (!resolved) return 1;
  try {
    const res = await cliFetch(`/api/sessions/${resolved.id}/messages?limit=${Math.min(limit, 50)}`);
    if (!res.ok) {
      console.error(`Peek failed (${res.status}): ${await res.text()}`);
      return 1;
    }
    const { messages } = await res.json();
    const ordered = [...messages].reverse();
    if (asJson) {
      console.log(JSON.stringify(ordered, null, 2));
      return 0;
    }
    if (!ordered.length) {
      console.log(`No messages for session ${resolved.id.slice(0, 8)}.`);
      return 0;
    }
    console.log(`Session ${resolved.id.slice(0, 8)}${resolved.customTitle ? ` — ${resolved.customTitle}` : ''}`);
    for (const m of ordered) {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('en-GB', { hour12: false }) : '--:--:--';
      const label = (m.type === 'tool_use' ? (m.tool || 'tool') : m.type).padEnd(10);
      const body = (m.text || m.detail || m.description || '').replace(/\s+/g, ' ').trim();
      console.log(`[${ts}] ${label} ${body.slice(0, 120)}${body.length > 120 ? '…' : ''}`);
    }
    return 0;
  } catch (e) { reportCliError(e); return 1; }
}

module.exports = { runCli };
