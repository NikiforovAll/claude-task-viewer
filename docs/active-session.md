# Active Session Definition

The **"Active Only"** filter in the session sidebar determines which sessions are considered active and worth showing. A session is active if **any** of the following conditions are true:

## Conditions

### 1. Has pending tasks
The session has one or more tasks with status `pending`.

### 2. Has in-progress tasks
The session has one or more tasks with status `in_progress`.

### 3. Has active agents
The session has at least one subagent with `active` or `idle` status in its agent-activity JSON **and** the agent's `updatedAt` is within the last **1 hour**. Agents older than 1 hour are considered stale (e.g. orphaned by a crashed session). For team sessions, agents are resolved via the team leader's session ID.

### 4. Has a recent plan
The session has an associated plan file **and** was last modified within the last **15 minutes**. Plans alone don't keep a session active indefinitely — once activity stops, the session fades from the active list.

### 5. Recent session log
The session's JSONL conversation log file was modified within the last **5 minutes** (`AGENT_STALE_MS`). This directly reflects Claude Code writing to the session, regardless of whether tasks or agents are visible.

### 6. Recently modified
The session was last modified within the last **5 minutes**, regardless of task/agent/plan state. This catches sessions with recent activity that may not yet have tasks or agents visible.

### 7. Waiting for user input
The session has a fresh `_waiting.json` marker (< 30 min old, `PERMISSION_TTL_MS`) in its agent-activity directory. This covers both permission prompts (`PermissionRequest`) and user questions (`AskUserQuestion`). These sessions need attention even if they have no tasks or agents. The marker is auto-resolved if the session's JSONL log was modified after the marker timestamp plus a grace period (`WAITING_RESOLVE_GRACE_MS`, 5s) — this handles cases where `PostToolUse` never fires (e.g. `ExitPlanMode`).

### 8. Plan session with active implementation
The session is a plan session with a `planImplementationSessionId` that points to another session which passes the active filter. This keeps correlated plan+implementation pairs visible together — if the implementation session is active, its parent plan session is included too.

## Design Principles

- **Tasks are always-on signals** — if work is happening, the session is active regardless of age.
- **Agents are time-gated (1h)** — active/idle agents keep a session active, but stale agents (>1h since last update) are ignored to handle orphaned processes.
- **Session log is a direct activity signal** — JSONL mtime reflects actual Claude Code activity, computed once per session via `getSessionLogMtime()`.
- **Waiting for user is an always-on signal** — permission prompts and questions require attention regardless of age (within the 5 min TTL).
- **Plans are time-gated** — a plan file persists on disk indefinitely, so we use recency to avoid showing stale sessions.
- **Recency as a catch-all** — the 5-minute window ensures any recently touched session stays visible briefly.
- **Trust the source data** — agent status comes directly from the JSON files Claude Code writes.
