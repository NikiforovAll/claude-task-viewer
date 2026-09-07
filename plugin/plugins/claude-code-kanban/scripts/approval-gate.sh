#!/bin/bash
# Blocking approval gate: lets the cck board answer a permission ask or an
# AskUserQuestion. Always writes the _waiting.json marker first (badge behavior
# is unchanged when the feature is off), then — only when explicitly enabled and
# the board's server is alive — waits for a decision file written by the server.
#
# Contract (_plans/cck-ui-approvals/decisions.md), rooted at <CLAUDE_CONFIG_DIR or ~/.claude>/.cck:
#   marker    agent-activity/<sid>/_waiting.json            (D8: + id, cwd, permissionSuggestions)
#   decision  agent-activity/<sid>/_decision-<id>.json      (server writes it, Phase 3)
#   config    approvals.json {enabled, mode, waitSeconds}   (D2: fail-open when absent)
#   liveness  server.json {port, pid}                       (D1: a dead board costs nothing)
#
# First writer wins (D5): a terminal answer deletes the marker via PostToolUse
# and this gate exits silently; a decision arriving after the tool already ran
# is discarded by Claude Code, so a losing write on either side is harmless.

INPUT=$(cat)

eval "$(echo "$INPUT" | jq -r '
  @sh "SESSION_ID=\(.session_id // "")",
  @sh "EVENT=\(.hook_event_name // "")",
  @sh "TOOL_NAME=\(.tool_name // "")"
')"

[ -z "$SESSION_ID" ] && exit 0

# AskUserQuestion and ExitPlanMode gate on PermissionRequest, not PreToolUse:
# the TUI question and plan dialogs render ~10 s in while a PermissionRequest
# hook blocks (first writer wins, like permissions), but stay frozen for the
# whole wait during a PreToolUse hook — measured live (#42, #40). Suppress the
# PreToolUse double-fire in case a stale hooks.json still registers it.
if [ "$EVENT" = "PreToolUse" ]; then
  exit 0
fi

KIND="permission"
[ "$TOOL_NAME" = "AskUserQuestion" ] && KIND="question"
[ "$TOOL_NAME" = "ExitPlanMode" ] && KIND="plan"

CCK_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.cck"
DIR="$CCK_DIR/agent-activity/$SESSION_ID"
MARKER="$DIR/_waiting.json"
mkdir -p "$DIR"

# uuidgen is missing on some Git Bash installs; uniqueness only has to hold
# across the asks of one session, so a timestamp compound is enough
REQ_ID=$(uuidgen 2>/dev/null) || REQ_ID="$(date +%s%N)-$$-$RANDOM"

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "$INPUT" | jq -c --arg kind "$KIND" --arg ts "$TS" --arg id "$REQ_ID" '{
  status: "waiting",
  kind: $kind,
  id: $id,
  toolName: (.tool_name // "unknown"),
  toolInput: ((.tool_input | tostring) // ""),
  cwd: (.cwd // ""),
  permissionSuggestions: (.permission_suggestions // []),
  timestamp: $ts
}' > "$MARKER"

# Every exit below leaves the marker in place for the badge; agent-spy.sh's
# PostToolUse (or the server's TTL) retires it, exactly as before this feature.

CONFIG="$CCK_DIR/approvals.json"
[ -f "$CONFIG" ] || exit 0
ENABLED=""
eval "$(jq -r '
  @sh "ENABLED=\(.enabled // false)",
  @sh "MODE=\(.mode // "permission")",
  @sh "WAIT_SECONDS=\(.waitSeconds // 30)"
' < "$CONFIG" 2>/dev/null)"
[ "$ENABLED" = "true" ] || exit 0

if [ "$KIND" = "question" ] && [ "$MODE" != "permission+question" ]; then
  exit 0
fi

case "$WAIT_SECONDS" in *[!0-9]* | "") WAIT_SECONDS=30 ;; esac
# PERMISSION_TTL_MS hides the card at 30 min — waiting longer than the UI can
# show the ask is strictly worse than giving up (D11)
[ "$WAIT_SECONDS" -gt 1800 ] && WAIT_SECONDS=1800

SERVER_INFO="$CCK_DIR/server.json"
[ -f "$SERVER_INFO" ] || exit 0
SERVER_PORT=$(jq -r '.port // empty' < "$SERVER_INFO" 2>/dev/null)
[ -n "$SERVER_PORT" ] || exit 0
# A TCP connect beats a pid probe: it proves the board is actually serving, and
# it works in the stripped environment Claude Code spawns hooks into, where
# kill -0 cannot see native Windows pids and ps may be missing from PATH
(: < "/dev/tcp/127.0.0.1/$SERVER_PORT") 2>/dev/null || exit 0

DECISION="$DIR/_decision-$REQ_ID.json"
# EPOCHSECONDS (bash 5) keeps the poll loop free of `date` spawns
DEADLINE=$((EPOCHSECONDS + WAIT_SECONDS))

while :; do
  if [ -f "$DECISION" ]; then
    PAYLOAD=$(cat "$DECISION" 2>/dev/null)
    rm -f "$DECISION" "$MARKER"
    [ -n "$PAYLOAD" ] || exit 0
    if [ "$KIND" = "plan" ] && [ "$(echo "$PAYLOAD" | jq -r '.behavior // "deny"' 2>/dev/null)" = "allow" ]; then
      # A plan allow must echo tool_input as updatedInput — Claude Code
      # >= 2.1.199 silently drops an ExitPlanMode allow without it and falls
      # back to the built-in dialog (measured; plannotator does the same).
      echo "$INPUT" | jq -c --argjson p "$PAYLOAD" \
        '{hookSpecificOutput: {hookEventName: "PermissionRequest",
          decision: ({behavior: "allow", updatedInput: (.tool_input // {})}
          + (if $p.updatedPermissions then {updatedPermissions: $p.updatedPermissions} else {} end))}}' 2>/dev/null
    elif [ "$KIND" != "question" ]; then
      # Permission asks and plan denies share this shaping — the server sends
      # only behavior+message for a plan deny. PermissionRequest decisions must
      # ride hookSpecificOutput — a top-level {decision} is the approve/block
      # string channel and an object there throws
      echo "$PAYLOAD" | jq -c '{hookSpecificOutput: {hookEventName: "PermissionRequest",
        decision: ({behavior: (.behavior // "deny")}
        + (if .message then {message: .message} else {} end)
        + (if .updatedInput then {updatedInput: .updatedInput} else {} end)
        + (if .updatedPermissions then {updatedPermissions: .updatedPermissions} else {} end))}}' 2>/dev/null
    else
      # updatedInput replaces the whole input object, so echo every field and
      # add the answers Claude never fills in itself (D6). Questions ride the
      # PermissionRequest channel now (#42) — allow with the answers filled in.
      ANSWERS=$(echo "$PAYLOAD" | jq -c '.answers // empty' 2>/dev/null)
      [ -n "$ANSWERS" ] || exit 0
      echo "$INPUT" | jq -c --argjson answers "$ANSWERS" \
        '{hookSpecificOutput: {hookEventName: "PermissionRequest",
          decision: {behavior: "allow", updatedInput: ((.tool_input // {}) + {answers: $answers})}}}' 2>/dev/null
    fi
    exit 0
  fi

  # Marker gone = answered in the terminal (PostToolUse fires ~23 ms after — D5);
  # id changed = displaced by a newer ask (D8). Either way this gate is over.
  # Builtin read + substring match instead of jq: a spawn costs ~280 ms on
  # Windows (O2), and the marker is single-line jq -c output with a known id.
  IFS= read -r CUR_MARKER < "$MARKER" 2>/dev/null || exit 0
  case "$CUR_MARKER" in *"\"id\":\"$REQ_ID\""*) ;; *) exit 0 ;; esac

  [ "$EPOCHSECONDS" -ge "$DEADLINE" ] && exit 0
  sleep 0.5
done
