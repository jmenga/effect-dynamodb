#!/usr/bin/env bash
#
# Run all examples sequentially against DynamoDB Local.
#
# Prerequisites:
#   docker run -p 8000:8000 amazon/dynamodb-local
#
# Usage:
#   ./scripts/run-examples.sh
#
# The script exits with a non-zero code if any example fails.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLES_DIR="$PROJECT_DIR/examples"

# Collect all example files, sorted for deterministic order
mapfile -t examples < <(find "$EXAMPLES_DIR" -maxdepth 1 -name '*.ts' -type f | sort)

if [[ ${#examples[@]} -eq 0 ]]; then
  echo "ERROR: No example files found in $EXAMPLES_DIR"
  exit 1
fi

echo "Running ${#examples[@]} examples against DynamoDB Local..."
echo ""

failed=0
passed=0

for example in "${examples[@]}"; do
  name="$(basename "$example")"
  echo "--- Running: $name ---"

  if npx tsx "$example"; then
    echo "--- PASSED: $name ---"
    echo ""
    passed=$((passed + 1))
  else
    echo "--- FAILED: $name ---"
    echo ""
    failed=$((failed + 1))
  fi
done

echo "========================================="
echo "Results: $passed passed, $failed failed (${#examples[@]} total)"
echo "========================================="

if [[ $failed -gt 0 ]]; then
  exit 1
fi
