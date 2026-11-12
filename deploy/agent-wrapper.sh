#!/usr/bin/env sh
# =============================================================================
# Agent runtime wrapper (template)
#
# The worker starts this command with two arguments:
#   $1 workspace   a fresh, isolated directory containing the cloned repository
#   $2 promptFile  the task prompt written by the control plane
#
# The command must:
#   1. run the coding agent headlessly inside $1 (DSH headless recommended);
#   2. leave the repository changes in the working tree (do NOT push);
#   3. write $1/.superagent/result.json before exiting 0:
#        { "summary": "...", "plan": "...", "tokens": 1234, "cost": 0.01 }
#
# `plan` is required for plan runs, `summary` for execute runs. The worker
# commits the branch, pushes agent/* and opens the PR itself.
#
# Fail with a non-zero exit code and print the reason to stderr on failure.
# =============================================================================

set -eu

WORKSPACE="$1"
PROMPT_FILE="$2"
RESULT_DIR="$WORKSPACE/.superagent"
RESULT_FILE="$RESULT_DIR/result.json"
LOG_FILE="$RESULT_DIR/agent.jsonl"

mkdir -p "$RESULT_DIR"

# Replace the command below with the real DSH headless invocation for your
# installation. The `dsh` CLI flags differ between versions; adapt them here
# instead of changing the platform.
#
# Example shape:
#   dsh run --headless \
#     --workspace "$WORKSPACE" \
#     --prompt-file "$PROMPT_FILE" \
#     --output jsonl | tee "$LOG_FILE"
#
# The pipeline only depends on the exit code and result.json contract, so any
# agent runner can be substituted (see src/domain/runtime.ts).

echo "agent wrapper: no agent command configured" >&2
echo "edit /opt/superagent/agent-wrapper.sh to invoke DSH headless" >&2
exit 70
