# Agent Log — Specification

## Overview

The Agent Log visualizes Claude Code subagent lifecycle events (start, stop, idle) in a collapsible footer panel below the Kanban board. It works for both regular subagent sessions and team sessions.

## Architecture

```
Claude Code spawns subagent
  → hook (SubagentStart/SubagentStop/TeammateIdle) fires
  → agent-spy.sh writes JSON to ~/.claude/agent-activity/{sessionId}/{agentId}.json
  → chokidar detects file change
  → server broadcasts SSE "agent-update" event
  → frontend fetches updated agent list via REST API
  → renders Agent Log footer
```

## Hook: `~/.claude/hooks/agent-spy.sh`

Configured in `~/.claude/settings.json` for three events: `SubagentStart`, `SubagentStop`, `TeammateIdle`.

**File layout:** `~/.claude/agent-activity/{sessionId}/{agentId}.json` — one file per agent, grouped by session.

**SubagentStart:** Creates file with `status: "active"`. Skips internal agents (empty `agent_type`, e.g. AskUserQuestion).

**SubagentStop:** Overwrites file with `status: "stopped"`, preserves `startedAt` from existing file, captures `last_assistant_message`. Falls back to reading `type` from existing file if `agent_type` is empty.

**TeammateIdle:** Overwrites file with `status: "idle"`, preserves `startedAt`.

### Agent JSON schema

```json
{
  "agentId": "a1b2c3...",
  "type": "general-purpose",
  "status": "active|idle|stopped",
  "startedAt": "2026-03-01T17:00:00Z",
  "updatedAt": "2026-03-01T17:00:30Z",
  "stoppedAt": "2026-03-01T17:00:30Z",
  "lastMessage": "Task completed. Summary: ..."
}
```

## Server (`server.js`)

### REST endpoint

`GET /api/sessions/:sessionId/agents` — returns array of agent objects. For team sessions, resolves `sessionId` to the leader's UUID via team config before reading files.

### File watcher

Watches `~/.claude/agent-activity/` (depth 2). On `add`/`change` of `.json` files:
1. Broadcasts `{ type: "agent-update", sessionId }` via SSE
2. For team sessions, also broadcasts with team name so frontend picks it up
3. On `add`: enforces file cap (20 files per session), deletes oldest by mtime

### File cap

`AGENT_FILE_CAP = 20` — when a new agent file is added and the session directory exceeds the cap, the oldest files (by modification time) are deleted. This prevents unbounded disk growth across long sessions.

## Frontend (`public/index.html`)

### Display

- Collapsible footer panel below the Kanban board
- Horizontal scrollable row of agent cards
- Each card shows: status dot (green=active, yellow=idle, gray=stopped), agent type, duration, truncated last message (60 chars + ellipsis)
- Clicking a card opens a modal with full details (status, ID, duration, timestamps, markdown-rendered last message)
- ESC closes modal
- Collapse state persisted in `localStorage` key `agentFooterCollapsed`
- Display cap: `AGENT_LOG_MAX = 8` most recent agents

### Ghost filtering

Shutdown handshake creates duplicate agent instances per worker. Three rounds:

| Round | Behavior | How filtered |
|-------|----------|-------------|
| Real worker | Runs task, stops with meaningful message | Kept |
| Shutdown recap | Same type, starts after original stops, has recap message | Temporal dedup |
| Shutdown approval | Same type, starts after recap, often no SubagentStop | Temporal dedup |

**Temporal dedup algorithm:** For same-type agents sorted by `startedAt`:
- If agent overlapped with previous (started before previous stopped) → keep (parallel real agents)
- If agent started >30s after previous stopped → keep (legitimate re-spawn)
- Otherwise → filter (shutdown ghost)

### Stale timeout

`AGENT_STALE_MS = 300000` (5 min) — active agents whose `startedAt` exceeds this threshold are marked as stopped in the UI. This handles cases where `SubagentStop` never fires.

### SSE handler

Listens for `type: "agent-update"` events. If `sessionId` matches current session, triggers debounced `fetchAgents()` call.

## Configuration constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `AGENT_FILE_CAP` | 20 | server.js | Max agent files per session on disk |
| `AGENT_LOG_MAX` | 8 | index.html | Max agents shown in footer |
| `AGENT_STALE_MS` | 300000 | index.html | Stale timeout for active agents (5 min) |
| `AGENT_COOLDOWN_MS` | 180000 | index.html | Cooldown period constant (3 min) |

## Known limitations

- `SubagentStop` is intermittently unreliable — may not fire for some agents. Mitigated by 5-minute stale timeout.
- Shutdown handshake spawns transient agent instances that never receive `SubagentStop`. Mitigated by temporal dedup filter.
- Hook `SubagentStart` does not provide agent prompt/description — only `agent_type` is available for identification.
- Internal agents (e.g. AskUserQuestion) have empty `agent_type` and are excluded.
