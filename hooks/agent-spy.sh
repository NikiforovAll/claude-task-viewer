#!/bin/bash
# Tracks subagent lifecycle: one JSON file per agent, grouped by session
# Layout: ~/.claude/agent-activity/{sessionId}/{agentId}.json

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')

[ -z "$SESSION_ID" ] || [ -z "$AGENT_ID" ] && exit 0

AGENT_TYPE_RAW=$(echo "$INPUT" | jq -r '.agent_type // empty')
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
  # Read type and startedAt from existing file if available
  AGENT_TYPE="$AGENT_TYPE_RAW"
  STARTED_AT="$TS"
  if [ -f "$FILE" ]; then
    [ -z "$AGENT_TYPE" ] && AGENT_TYPE=$(jq -r '.type // "unknown"' "$FILE")
    STARTED_AT=$(jq -r '.startedAt // empty' "$FILE")
    [ -z "$STARTED_AT" ] && STARTED_AT="$TS"
  fi
  LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')
  LAST_MSG_ESC=$(echo "$LAST_MSG" | jq -Rs '.')
  cat > "$FILE" <<EOF
{"agentId":"$AGENT_ID","type":"$AGENT_TYPE","status":"stopped","startedAt":"$STARTED_AT","lastMessage":$LAST_MSG_ESC,"stoppedAt":"$TS","updatedAt":"$TS"}
EOF

elif [ "$EVENT" = "TeammateIdle" ]; then
  AGENT_TYPE="$AGENT_TYPE_RAW"
  STARTED_AT="$TS"
  if [ -f "$FILE" ]; then
    [ -z "$AGENT_TYPE" ] && AGENT_TYPE=$(jq -r '.type // "unknown"' "$FILE")
    STARTED_AT=$(jq -r '.startedAt // empty' "$FILE")
    [ -z "$STARTED_AT" ] && STARTED_AT="$TS"
  fi
  cat > "$FILE" <<EOF
{"agentId":"$AGENT_ID","type":"$AGENT_TYPE","status":"idle","startedAt":"$STARTED_AT","updatedAt":"$TS"}
EOF
fi
