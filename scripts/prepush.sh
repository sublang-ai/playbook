#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

# The pre-push check (release-42, DR-095): no conflict marker in the
# tree, then the spec lint and the type check — what the first CI
# minute would refuse.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

pattern='^(<<<<<<< |=======$|>>>>>>> )'
excluded=(':!scripts/prepush.sh' ':!src/merge-gate.test.ts')
status=0
markers="$(git grep -nE "$pattern" -- "${excluded[@]}")" || status=$?
if [ "$status" -eq 0 ]; then
  echo "prepush: conflict markers left in the tree:" >&2
  printf '%s\n' "$markers" >&2
  exit 1
fi
# git grep exits 1 for no match; anything else is its own failure.
[ "$status" -eq 1 ] || exit "$status"

PATH="$root/node_modules/.bin:$PATH"
spex lint
tsc --noEmit
echo "prepush: clean"
