#!/usr/bin/env bash
# Runs Carl's verification gate in the same order CI does, stopping at the first failure.
#
# Exists because checking a command's output with grep is not the same as checking whether
# it succeeded — a `grep -c "Done"` once reported a passing typecheck while two packages
# were failing.
set -uo pipefail

log=$(mktemp)
status=0

run() {
  local name=$1
  shift
  printf '%-12s ' "$name"
  if "$@" >"$log" 2>&1; then
    printf 'PASS\n'
  else
    printf 'FAIL\n\n'
    tail -40 "$log"
    status=1
    return 1
  fi
}

run format    pnpm run format:check || exit $status
run typecheck pnpm run typecheck    || exit $status
run lint      pnpm run lint         || exit $status
run test      pnpm run test         || exit $status
run build     pnpm run build        || exit $status

printf '\nAll gates passed.\n'
