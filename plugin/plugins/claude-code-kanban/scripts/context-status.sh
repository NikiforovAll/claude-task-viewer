#!/bin/bash
# Statusline spy: writes raw context data for kanban dashboard, passes input through
# Layout: <CLAUDE_CONFIG_DIR or ~/.claude>/.cck/context-status/{sessionId}.json
#
# Usage: pipe before your statusline command:
#   "command": "~/.claude/hooks/context-status.sh | npx -y ccstatusline@latest"

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
if [ -n "$SESSION_ID" ]; then
  DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.cck/context-status"
  mkdir -p "$DIR"
  echo "$INPUT" > "$DIR/$SESSION_ID.json"
fi

# Pass through original input for downstream statusline
echo "$INPUT"
