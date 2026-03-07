#!/bin/bash
# Tracks subagent lifecycle: one JSON file per agent, grouped by session
# Layout: ~/.claude/agent-activity/{sessionId}/{agentId}.json

INPUT=$(cat)

# Single jq call to extract all routing fields (was 3-4 separate calls)
eval "$(echo "$INPUT" | jq -r '
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "AGENT_ID=\(.agent_id // "")",
  @sh "EVENT=\(.hook_event_name // "")",
  @sh "TOOL_NAME=\(.tool_name // "")",
  @sh "AGENT_TYPE_RAW=\(.agent_type // "")"
')"

[ -z "$SESSION_ID" ] && exit 0

# PostToolUse / non-waiting PreToolUse: clear waiting state
if [ "$EVENT" = "PostToolUse" ] || { [ "$EVENT" = "PreToolUse" ] && [ "$TOOL_NAME" != "AskUserQuestion" ]; }; then
  WFILE="$HOME/.claude/agent-activity/$SESSION_ID/_waiting.json"
  rm -f "$WFILE"
  [ "$EVENT" = "PostToolUse" ] && exit 0
fi

# Plan mode tools don't fire PostToolUse — skip to avoid stale markers
[ "$TOOL_NAME" = "EnterPlanMode" ] || [ "$TOOL_NAME" = "ExitPlanMode" ] && exit 0

# Waiting-for-user events → write _waiting.json marker
if [ "$EVENT" = "PermissionRequest" ] || { [ "$EVENT" = "PreToolUse" ] && [ "$TOOL_NAME" = "AskUserQuestion" ]; }; then
  DIR="$HOME/.claude/agent-activity/$SESSION_ID"
  mkdir -p "$DIR"
  KIND="permission"
  [ "$EVENT" = "PreToolUse" ] && KIND="question"
  TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "$INPUT" | jq -c --arg kind "$KIND" --arg ts "$TS" '{
    status: "waiting",
    kind: $kind,
    toolName: (.tool_name // "unknown"),
    toolInput: ((.tool_input | tostring)[0:200] // ""),
    timestamp: $ts
  }' > "$DIR/_waiting.json"
  exit 0
fi

[ -z "$AGENT_ID" ] && exit 0

DIR="$HOME/.claude/agent-activity/$SESSION_ID"
FILE="$DIR/$AGENT_ID.json"

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
  cat > "$FILE" <<EOF
{"agentId":"$AGENT_ID","type":"$AGENT_TYPE_RAW","status":"active","startedAt":"$TS","updatedAt":"$TS"}
EOF

elif [ "$EVENT" = "SubagentStop" ]; then
  AGENT_TYPE="$AGENT_TYPE_RAW"
  STARTED_AT="$TS"
  if [ -f "$FILE" ]; then
    eval "$(jq -r '@sh "PREV_TYPE=\(.type // "unknown")", @sh "PREV_START=\(.startedAt // "")"' "$FILE")"
    [ -z "$AGENT_TYPE" ] && AGENT_TYPE="$PREV_TYPE"
    [ -n "$PREV_START" ] && STARTED_AT="$PREV_START"
  fi
  echo "$INPUT" | jq -c \
    --arg id "$AGENT_ID" --arg type "$AGENT_TYPE" --arg started "$STARTED_AT" --arg ts "$TS" \
    '{agentId: $id, type: $type, status: "stopped", startedAt: $started,
      lastMessage: (.last_assistant_message // ""), stoppedAt: $ts, updatedAt: $ts}' \
    > "$FILE"

elif [ "$EVENT" = "TeammateIdle" ]; then
  AGENT_TYPE="$AGENT_TYPE_RAW"
  STARTED_AT="$TS"
  if [ -f "$FILE" ]; then
    eval "$(jq -r '@sh "PREV_TYPE=\(.type // "unknown")", @sh "PREV_START=\(.startedAt // "")"' "$FILE")"
    [ -z "$AGENT_TYPE" ] && AGENT_TYPE="$PREV_TYPE"
    [ -n "$PREV_START" ] && STARTED_AT="$PREV_START"
  fi
  cat > "$FILE" <<EOF
{"agentId":"$AGENT_ID","type":"$AGENT_TYPE","status":"idle","startedAt":"$STARTED_AT","updatedAt":"$TS"}
EOF
fi
