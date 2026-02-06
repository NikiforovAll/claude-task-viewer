# Claude Code Kanban

[![npm version](https://img.shields.io/npm/v/claude-code-kanban)](https://www.npmjs.com/package/claude-code-kanban)
[![license](https://img.shields.io/npm/l/claude-code-kanban)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/claude-code-kanban)](https://www.npmjs.com/package/claude-code-kanban)

> Watch Claude Code think, in real time.

![Dark mode](assets/screenshot-dark-v2.png)

![Light mode](assets/screenshot-light-v2.png)

## Features

- **Real-time updates** — Tasks move through Pending → In Progress → Completed as Claude works
- **Agent teams** — Color-coded team members, owner filtering, member count badges
- **Task dependencies** — See blockedBy/blocks relationships and the critical path
- **Live activity feed** — Stream of all in-progress tasks across every session
- **Session management** — Fuzzy search, project/branch display, active session indicators
- **Cleanup** — Delete tasks (with dependency checks) or bulk-delete entire sessions
- **Keyboard shortcuts** — Press `?` for help

## Installation

```bash
npx claude-code-kanban
```

Open http://localhost:3456

### Global install

```bash
npm install -g claude-code-kanban
claude-code-kanban --open
```

## Configuration

```bash
PORT=8080 npx claude-code-kanban        # Custom port
npx claude-code-kanban --open            # Auto-open browser
npx claude-code-kanban --dir=~/.claude-work  # Custom Claude config dir
```

If port 3456 is in use, the server falls back to a random available port.

## FAQ

**Does this control Claude?**
No. Claude Code owns all task state. The viewer only observes — it never directs Claude's work.

**Does it work with agent teams?**
Yes. Team sessions are auto-detected with color-coded members and owner filtering.

**Does it require Claude Code to be running?**
No. It reads task files from `~/.claude/tasks/`. You can view past sessions anytime.

## License

MIT
