#!/bin/bash
# Tracks subagent lifecycle: one append-only JSONL file per agent, grouped by session
# Layout: <CLAUDE_CONFIG_DIR or ~/.claude>/.cck/agent-activity/{sessionId}/{agentId}.jsonl
# Each line is a lifecycle event (start | idle | stop). Server folds last-line-wins.

INPUT=$(cat)

# Single jq call to extract all routing fields
eval "$(echo "$INPUT" | jq -r '
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "AGENT_ID=\(.agent_id // "")",
  @sh "EVENT=\(.hook_event_name // "")",
  @sh "TOOL_NAME=\(.tool_name // "")",
  @sh "AGENT_TYPE_RAW=\(.agent_type // "")",
  @sh "TEAMMATE_NAME=\(.teammate_name // "")"
')"

[ -z "$SESSION_ID" ] && exit 0

CCK_ACTIVITY="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.cck/agent-activity"

# Map session to custom task list on session start
if [ "$EVENT" = "SessionStart" ]; then
  TASK_LIST_ID="${CLAUDE_CODE_TASK_LIST_ID:-}"
  if [ -n "$TASK_LIST_ID" ]; then
    CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
    MAPS_DIR="$CCK_ACTIVITY/_task-maps"
    mkdir -p "$MAPS_DIR"
    MAP_FILE="$MAPS_DIR/$TASK_LIST_ID.json"
    TMP_FILE="$MAP_FILE.$$"
    TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    EXISTING="{}"
    [ -f "$MAP_FILE" ] && EXISTING=$(cat "$MAP_FILE")
    echo "$EXISTING" | jq -c --arg sid "$SESSION_ID" --arg cwd "$CWD" --arg ts "$TS" \
      '.[$sid] = {project: $cwd, updatedAt: $ts}' > "$TMP_FILE" && mv "$TMP_FILE" "$MAP_FILE"
  fi
  exit 0
fi

# PostToolUse / non-waiting PreToolUse: clear waiting state
if [ "$EVENT" = "PostToolUse" ] || { [ "$EVENT" = "PreToolUse" ] && [ "$TOOL_NAME" != "AskUserQuestion" ] && [ "$TOOL_NAME" != "ExitPlanMode" ]; }; then
  WFILE="$CCK_ACTIVITY/$SESSION_ID/_waiting.json"
  rm -f "$WFILE"
  [ "$EVENT" = "PostToolUse" ] && exit 0
fi

# EnterPlanMode has no waiting semantics — skip
[ "$TOOL_NAME" = "EnterPlanMode" ] && exit 0

# Legacy-config shim: shipped hooks.json routes PermissionRequest to
# approval-gate.sh (which owns the id-bearing marker) and registers no
# PreToolUse, so the suppression and writer below only run for configs that
# still route those events here. Suppressing question/plan PermissionRequest
# keeps such a config from overwriting the gate's marker with an id-less one.
if [ "$EVENT" = "PermissionRequest" ] && { [ "$TOOL_NAME" = "AskUserQuestion" ] || [ "$TOOL_NAME" = "ExitPlanMode" ]; }; then
  exit 0
fi

# Waiting-for-user events → write _waiting.json marker
if [ "$EVENT" = "PermissionRequest" ] || { [ "$EVENT" = "PreToolUse" ] && { [ "$TOOL_NAME" = "AskUserQuestion" ] || [ "$TOOL_NAME" = "ExitPlanMode" ]; }; }; then
  DIR="$CCK_ACTIVITY/$SESSION_ID"
  mkdir -p "$DIR"
  KIND="permission"
  [ "$EVENT" = "PreToolUse" ] && KIND="question"
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "$INPUT" | jq -c --arg kind "$KIND" --arg ts "$TS" '{
    status: "waiting",
    kind: $kind,
    toolName: (.tool_name // "unknown"),
    toolInput: ((.tool_input | tostring) // ""),
    timestamp: $ts
  }' > "$DIR/_waiting.json"
  exit 0
fi

# TeammateIdle has no agent_id — resolve via name→id mapping file
if [ "$EVENT" = "TeammateIdle" ] && [ -z "$AGENT_ID" ] && [ -n "$TEAMMATE_NAME" ]; then
  DIR="$CCK_ACTIVITY/$SESSION_ID"
  MAP_FILE="$DIR/_name-${TEAMMATE_NAME}.id"
  [ ! -f "$MAP_FILE" ] && exit 0
  AGENT_ID=$(cat "$MAP_FILE")
  [ -z "$AGENT_ID" ] && exit 0
  FILE="$DIR/$AGENT_ID.jsonl"
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "{\"agentId\":\"$AGENT_ID\",\"type\":\"$TEAMMATE_NAME\",\"event\":\"idle\",\"status\":\"idle\",\"updatedAt\":\"$TS\"}" >> "$FILE"
  exit 0
fi

[ -z "$AGENT_ID" ] && exit 0

DIR="$CCK_ACTIVITY/$SESSION_ID"
FILE="$DIR/$AGENT_ID.jsonl"

# On Start: skip if no type (internal agents like AskUserQuestion)
# On Stop/Idle: only skip if no existing file (never tracked)
if [ -z "$AGENT_TYPE_RAW" ]; then
  if [ "$EVENT" = "SubagentStart" ]; then
    exit 0
  elif [ ! -f "$FILE" ]; then
    exit 0
  fi
fi

mkdir -p "$DIR"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ "$EVENT" = "SubagentStart" ]; then
  echo "{\"agentId\":\"$AGENT_ID\",\"type\":\"$AGENT_TYPE_RAW\",\"event\":\"start\",\"status\":\"active\",\"startedAt\":\"$TS\",\"updatedAt\":\"$TS\"}" >> "$FILE"
  # Mapping always points at latest agent of this type (used by TeammateIdle resolution).
  if [ -n "$AGENT_TYPE_RAW" ]; then
    echo -n "$AGENT_ID" > "$DIR/_name-${AGENT_TYPE_RAW}.id"
  fi

elif [ "$EVENT" = "SubagentStop" ]; then
  # Omit empty type: the server folds lines last-key-wins, so an empty type
  # here would clobber the type recorded by the start line
  echo "$INPUT" | jq -c \
    --arg id "$AGENT_ID" --arg type "$AGENT_TYPE_RAW" --arg ts "$TS" \
    '{agentId: $id, event: "stop", status: "stopped",
      lastMessage: (.last_assistant_message // ""), stoppedAt: $ts, updatedAt: $ts}
     + (if $type == "" then {} else {type: $type} end)' \
    >> "$FILE"

elif [ "$EVENT" = "TeammateIdle" ]; then
  TYPE_FIELD=""
  [ -n "$AGENT_TYPE_RAW" ] && TYPE_FIELD="\"type\":\"$AGENT_TYPE_RAW\","
  echo "{\"agentId\":\"$AGENT_ID\",${TYPE_FIELD}\"event\":\"idle\",\"status\":\"idle\",\"updatedAt\":\"$TS\"}" >> "$FILE"
fi
