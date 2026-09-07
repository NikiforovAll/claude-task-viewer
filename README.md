# Claude Code Kanban

[![npm version](https://img.shields.io/npm/v/claude-code-kanban)](https://www.npmjs.com/package/claude-code-kanban)
[![license](https://img.shields.io/npm/l/claude-code-kanban)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/claude-code-kanban)](https://www.npmjs.com/package/claude-code-kanban)

**[Live Demo & Docs](https://nikiforovall.blog/claude-code-kanban/)**

> Watch Claude Code work, in real time.

![Kanban board with session log](assets/shot-session-log.png)

## Getting Started

### 1. Install hooks (one-time setup)

Hooks enable subagent tracking, waiting-for-user detection, and session activity indicators. **Without hooks, you only see tasks — no agent log, no live indicators.**

```bash
npx claude-code-kanban --install
```

Non-destructive — existing settings in `~/.claude/settings.json` are preserved. Uninstall anytime with `npx claude-code-kanban --uninstall`.

Using another Claude config dir? Pass `--dir=<path>` (or set `CLAUDE_CONFIG_DIR`) to both `--install` and `--uninstall`. The plugin, hooks and statusLine land in that dir, and the hooks write their data under it when Claude Code runs with the same `CLAUDE_CONFIG_DIR`.

### 2. Start the dashboard

```bash
npx claude-code-kanban --open
```

### 3. Use Claude Code as usual

Tasks, agents, and messages appear on the board automatically — Claude Code writes task files and conversation logs to `~/.claude`, the dashboard watches them and streams updates to the browser via SSE. Moving a card is the one thing that flows the other way: the board notifies the owning session with the card subject and description, so the agent can act on it.

> **Empty board?** Claude Code ships the task tools off by default on some models — currently Opus 5, Fable 5 — so nothing writes task files and the board stays empty. Turn them on in `~/.claude/settings.json`:
>
> ```json
> { "env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "true" } }
> ```
>
> Then restart Claude Code. You can also add a task by hand from the board's Pending column.

## Features

- **Real-time Kanban board** — Tasks move through Pending → In Progress → Completed as Claude works
- **Session log** — The full conversation timeline: prompts, replies, tool calls and results (`Shift+L`)
- **Agent log** — Live subagent tracking with prompts, duration, status, and idle detection
- **Task detail panel** — Full description, notes, blockedBy/blocks dependencies, inline editing
- **Follow & pin** — Follow the latest message live (`Shift+M`), pin the messages that matter
- **Tool stats & impact** — Per-session tool usage breakdown and file impact
- **Waiting-for-user indicators** — Amber highlight on sessions needing permission or input
- **UI approvals (opt-in)** — Allow/deny permission asks and answer questions from the board — [docs](docs/ui-approvals.md)
- **Agent teams** — Color-coded team members, owner filtering, member count badges
- **17 color themes** — Dracula, Nord, Catppuccin, Gruvbox, Tokyo Night, and more — each in light and dark
- **Storage manager** — Inspect disk usage and clean up stale sessions and tasks
- **Session picker** — Jump to any session in the sidebar with `Shift+P`, filtering by name, project or branch
- **Keyboard-first** — Press `?` for the full shortcut reference

![Session info](assets/shot-session-info.png)

![Subagent preview](assets/shot-subagent-preview.png)

![Theme picker](assets/shot-theme-picker.png)


## Context Window Monitoring

Per-session context usage bars, token/cost breakdowns, and model info in the sidebar and detail panel. The installer copies `context-status.sh` — wire it into your statusline in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/hooks/context-status.sh | npx -y ccstatusline@latest",
    "padding": 0
  }
}
```

The script pipes through, so your existing statusline keeps working.

## Configuration

```bash
PORT=8080 npx claude-code-kanban             # Custom port (falls back if busy)
npx claude-code-kanban --open                # Auto-open browser
npx claude-code-kanban --dir=~/.claude-work  # Custom Claude config dir (or CLAUDE_CONFIG_DIR)
```

Global install: `npm install -g claude-code-kanban`, then `claude-code-kanban --open`.

## License

MIT
