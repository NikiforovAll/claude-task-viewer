#!/bin/bash
# Tests for hooks/agent-spy.sh
# Run: bash tests/test-agent-spy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$SCRIPT_DIR/hooks/agent-spy.sh"
TMPDIR=$(mktemp -d)
export HOME="$TMPDIR"
ACTIVITY_DIR="$TMPDIR/.claude/agent-activity"

PASS=0
FAIL=0

pass() { ((PASS++)); echo "  ✓ $1"; }
fail() { ((FAIL++)); echo "  ✗ $1: $2"; }

assert_file() {
  [ -f "$1" ] && pass "$2" || fail "$2" "file not found: $1"
}

assert_no_file() {
  [ ! -f "$1" ] && pass "$2" || fail "$2" "file should not exist: $1"
}

assert_json() {
  local file="$1" key="$2" expected="$3" label="$4"
  local actual
  actual=$(jq -r "$key" "$file" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected '$expected', got '$actual'"
  fi
}

run_hook() {
  echo "$1" | bash "$HOOK"
}

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# ─── PermissionRequest ──────────────────────────────────────────
echo "PermissionRequest:"

run_hook '{"session_id":"s1","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"npm install"},"agent_type":""}'
assert_file "$ACTIVITY_DIR/s1/_waiting.json" "creates _waiting.json"
assert_json "$ACTIVITY_DIR/s1/_waiting.json" ".status" "waiting" "status=waiting"
assert_json "$ACTIVITY_DIR/s1/_waiting.json" ".kind" "permission" "kind=permission"
assert_json "$ACTIVITY_DIR/s1/_waiting.json" ".toolName" "Bash" "toolName=Bash"

# ─── AskUserQuestion (PreToolUse) ───────────────────────────────
echo "AskUserQuestion:"

run_hook '{"session_id":"s2","agent_id":"","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which?"}]},"agent_type":""}'
assert_file "$ACTIVITY_DIR/s2/_waiting.json" "creates _waiting.json"
assert_json "$ACTIVITY_DIR/s2/_waiting.json" ".kind" "question" "kind=question"
assert_json "$ACTIVITY_DIR/s2/_waiting.json" ".toolName" "AskUserQuestion" "toolName=AskUserQuestion"

# ─── Plan mode tools are suppressed ──────────────────────────────
echo "Plan mode tool suppression:"

run_hook '{"session_id":"s-plan","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"ExitPlanMode","tool_input":{},"agent_type":""}'
assert_no_file "$ACTIVITY_DIR/s-plan/_waiting.json" "ExitPlanMode PermissionRequest suppressed"
run_hook '{"session_id":"s-plan","agent_id":"","hook_event_name":"PreToolUse","tool_name":"EnterPlanMode","tool_input":{},"agent_type":""}'
assert_no_file "$ACTIVITY_DIR/s-plan/_waiting.json" "EnterPlanMode PreToolUse suppressed"

# ─── PreToolUse (non-question) clears waiting ───────────────────
echo "PreToolUse non-question cleanup:"

# Create a waiting state with a regular tool, then clear with non-question PreToolUse
run_hook '{"session_id":"s-clear","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{},"agent_type":""}'
assert_file "$ACTIVITY_DIR/s-clear/_waiting.json" "PermissionRequest(Bash) creates _waiting.json"
run_hook '{"session_id":"s-clear","agent_id":"","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{},"agent_type":""}'
assert_no_file "$ACTIVITY_DIR/s-clear/_waiting.json" "PreToolUse(Read) clears _waiting.json"

# ─── PostToolUse clears waiting ──────────────────────────────────
echo "PostToolUse cleanup:"

run_hook '{"session_id":"s1","agent_id":"","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{},"agent_type":""}'
assert_no_file "$ACTIVITY_DIR/s1/_waiting.json" "removes _waiting.json"

# PostToolUse on session without _waiting.json — should not error
run_hook '{"session_id":"s-none","agent_id":"","hook_event_name":"PostToolUse","tool_name":"","tool_input":{},"agent_type":""}'
pass "no error when _waiting.json absent"

# ─── SubagentStart ──────────────────────────────────────────────
echo "SubagentStart:"

run_hook '{"session_id":"s3","agent_id":"a1","hook_event_name":"SubagentStart","tool_name":"","agent_type":"general-purpose"}'
assert_file "$ACTIVITY_DIR/s3/a1.json" "creates agent file"
assert_json "$ACTIVITY_DIR/s3/a1.json" ".status" "active" "status=active"
assert_json "$ACTIVITY_DIR/s3/a1.json" ".type" "general-purpose" "type=general-purpose"
assert_json "$ACTIVITY_DIR/s3/a1.json" ".agentId" "a1" "agentId preserved"

# ─── SubagentStart skips no-type agents ─────────────────────────
echo "SubagentStart (no type):"

run_hook '{"session_id":"s3","agent_id":"a-internal","hook_event_name":"SubagentStart","tool_name":"","agent_type":""}'
assert_no_file "$ACTIVITY_DIR/s3/a-internal.json" "skips agent with no type"

# ─── SubagentStop ───────────────────────────────────────────────
echo "SubagentStop:"

STARTED_BEFORE=$(jq -r '.startedAt' "$ACTIVITY_DIR/s3/a1.json")
run_hook '{"session_id":"s3","agent_id":"a1","hook_event_name":"SubagentStop","tool_name":"","agent_type":"","last_assistant_message":"Task done with \"quotes\""}'
assert_json "$ACTIVITY_DIR/s3/a1.json" ".status" "stopped" "status=stopped"
assert_json "$ACTIVITY_DIR/s3/a1.json" ".type" "general-purpose" "type inherited from start"
assert_json "$ACTIVITY_DIR/s3/a1.json" '.lastMessage' 'Task done with "quotes"' "lastMessage with special chars"
STARTED_AFTER=$(jq -r '.startedAt' "$ACTIVITY_DIR/s3/a1.json")
[ "$STARTED_BEFORE" = "$STARTED_AFTER" ] && pass "startedAt preserved from start" || fail "startedAt preserved" "was '$STARTED_BEFORE', now '$STARTED_AFTER'"

# ─── TeammateIdle ───────────────────────────────────────────────
echo "TeammateIdle:"

# Start a new agent, then idle it
run_hook '{"session_id":"s4","agent_id":"t1","hook_event_name":"SubagentStart","tool_name":"","agent_type":"explore"}'
run_hook '{"session_id":"s4","agent_id":"t1","hook_event_name":"TeammateIdle","tool_name":"","agent_type":""}'
assert_json "$ACTIVITY_DIR/s4/t1.json" ".status" "idle" "status=idle"
assert_json "$ACTIVITY_DIR/s4/t1.json" ".type" "explore" "type inherited from start"

# ─── Empty session_id → exit 0 ──────────────────────────────────
echo "Edge cases:"

run_hook '{"session_id":"","agent_id":"a1","hook_event_name":"SubagentStart","tool_name":"","agent_type":"test"}'
assert_no_file "$ACTIVITY_DIR//a1.json" "empty session_id skips"

# SubagentStop with no existing file and no agent_type → skip
run_hook '{"session_id":"s-new","agent_id":"a-ghost","hook_event_name":"SubagentStop","tool_name":"","agent_type":"","last_assistant_message":""}'
assert_no_file "$ACTIVITY_DIR/s-new/a-ghost.json" "stop with no prior file and no type skips"

# ─── Special characters in tool_input ────────────────────────────
echo "Special characters:"

run_hook '{"session_id":"s5","agent_id":"","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"echo \"hello $USER\" && rm -rf /"},"agent_type":""}'
# Should produce valid JSON
jq . "$ACTIVITY_DIR/s5/_waiting.json" > /dev/null 2>&1 && pass "valid JSON with special chars in tool_input" || fail "valid JSON" "invalid JSON output"

# ─── updatedAt field present for TTL checks ─────────────────────
echo "Timestamp fields:"

assert_json "$ACTIVITY_DIR/s3/a1.json" ".updatedAt" "$(jq -r '.updatedAt' "$ACTIVITY_DIR/s3/a1.json")" "updatedAt present on stopped agent"
assert_json "$ACTIVITY_DIR/s4/t1.json" ".updatedAt" "$(jq -r '.updatedAt' "$ACTIVITY_DIR/s4/t1.json")" "updatedAt present on idle agent"

# Verify updatedAt is a valid ISO timestamp
UPDATED=$(jq -r '.updatedAt' "$ACTIVITY_DIR/s3/a1.json")
[[ "$UPDATED" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && pass "updatedAt is ISO format" || fail "updatedAt format" "got '$UPDATED'"

# ─── Summary ─────────────────────────────────────────────────────
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
