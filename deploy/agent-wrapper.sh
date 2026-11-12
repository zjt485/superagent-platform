#!/usr/bin/env sh
# =============================================================================
# Dual-agent runtime wrapper (template)
#
# The worker calls this command for every Turn (Main Session eval or Executor
# Session execute). Arguments:
#   1 workspace    Main: scratch dir; Executor: persistent ticket checkout
#   2 promptFile   role system prompt
#   3 inputFile    structured packet JSON (role, policy, thread/ticket, etc.)
#   4 resultFile   where the wrapper must write .superagent/result.json
#   5 turnId
#   6 ticketId     empty for Main Session turns
#
# It must write:
#   { "output": <role protocol>, "tokens": 1234, "cost": 0.0123 }
# and exit 0. Do not push branches or create pull requests; the platform does
# that after the Executor reports ready.
# =============================================================================

set -eu

WORKSPACE="$1"
PROMPT_FILE="$2"
INPUT_FILE="$3"
RESULT_FILE="$4"
TURN_ID="$5"
TICKET_ID="${6:-}"
RESULT_DIR="$(dirname "$RESULT_FILE")"

mkdir -p "$RESULT_DIR"

# Replace this with the real DSH headless invocation. It should:
#   - read the role prompt and input packet;
#   - resume the DSH session named by $SUPERAGENT_SESSION_ID when possible;
#   - run in $WORKSPACE;
#   - write $RESULT_FILE with the output protocol;
#   - print JSONL progress events to stdout if desired.
#
# Example shape:
#   dsh run --headless \
#     --workspace "$WORKSPACE" \
#     --prompt-file "$PROMPT_FILE" \
#     --input-file "$INPUT_FILE" \
#     --session "$SUPERAGENT_SESSION_ID" \
#     --output jsonl > "$RESULT_DIR/agent.jsonl"
#   # then convert the agent's final message into $RESULT_FILE

echo "agent wrapper: no agent command configured" >&2
echo "role=$SUPERAGENT_ROLE turn=$TURN_ID ticket=$TICKET_ID" >&2
echo "edit /opt/superagent/agent-wrapper.sh to invoke DSH headless" >&2
exit 70
