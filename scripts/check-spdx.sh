#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

# Verify LIC-3 and LIC-4 from specs/test/licensing.md: every git-tracked
# file with comment syntax that is not in the exclusions list from
# specs/dev/licensing.md must contain SPDX-FileCopyrightText (LIC-3) in
# its first comment block after any shebang, and SPDX-License-Identifier
# (LIC-4) when a license file is present at project root.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# License-file detection per specs/dev/licensing.md §License File
# Detection. Sets license_present=1 if any matching artifact exists at
# the project root.
license_present=0
shopt -s nullglob
for f in LICENSE LICENSE.* LICENCE LICENCE.* COPYING; do
  [[ -f "$f" ]] && license_present=1
done
shopt -u nullglob
[[ -d LICENSES ]] && license_present=1

# Exclusions per specs/dev/licensing.md §Exclusions. Returns 0 (true)
# when the path is out of scope for header checking.
is_excluded() {
  local f="$1"
  local base
  base="$(basename "$f")"

  # No comment syntax / binary-equivalent.
  case "$f" in
    *.json|*.ico|*.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg|*.woff|*.woff2|*.ttf|*.eot|*.pdf|*.zip|*.tar|*.tar.gz|*.tgz|*.gz) return 0 ;;
  esac

  # Config files (matched by basename so any depth applies).
  case "$base" in
    .gitignore|.gitattributes|.editorconfig|.npmrc|.nvmrc|.node-version|.gitkeep|AGENTS.md|CLAUDE.md|settings.json|*.lock|pnpm-lock.yaml|pnpm-workspace.yaml|package-lock.json|yarn.lock) return 0 ;;
  esac

  # CI workflow YAML (specs/dev/licensing.md names ci.yml as an
  # example exclusion; the rule covers any workflow file).
  case "$f" in
    .github/workflows/*.yml|.github/workflows/*.yaml) return 0 ;;
  esac

  # Generated / vendor trees.
  case "$f" in
    node_modules/*|*/node_modules/*|dist/*|*/dist/*|build/*|*/build/*|vendor/*|*/vendor/*) return 0 ;;
  esac

  # TypeScript declaration files: emitted by `tsc` without preserving
  # leading line comments, so the SPDX header on the .ts source does
  # not survive into the .d.ts sibling. The .d.ts files ship alongside
  # the .js (per code.playbook/package.json's `files` field) and are
  # already covered by the source .ts.
  case "$f" in
    *.d.ts) return 0 ;;
  esac

  # License / legal documents.
  case "$base" in
    LICENSE|LICENSE.*|LICENCE|LICENCE.*|COPYING|NOTICE) return 0 ;;
  esac
  case "$f" in
    LICENSES/*) return 0 ;;
  esac

  return 1
}

missing_copyright=()
missing_license=()
checked=0

while IFS= read -r f; do
  is_excluded "$f" && continue
  [[ -f "$f" ]] || continue
  checked=$((checked + 1))

  # Inspect the first 20 lines so the SPDX directives in the file's
  # first comment block are in scope.
  head_content="$(head -n 20 "$f" || true)"

  # Strip a leading shebang line if present (LIC-3 / LIC-4 say
  # "first comment block after any shebang").
  if printf '%s\n' "$head_content" | head -n 1 | grep -q '^#!'; then
    head_content="$(printf '%s\n' "$head_content" | tail -n +2)"
  fi

  if ! printf '%s\n' "$head_content" | grep -q "SPDX-FileCopyrightText"; then
    missing_copyright+=("$f")
    continue
  fi

  if [[ "$license_present" -eq 1 ]]; then
    if ! printf '%s\n' "$head_content" | grep -q "SPDX-License-Identifier"; then
      missing_license+=("$f")
    fi
  fi
done < <(git ls-files)

status=0
if [[ ${#missing_copyright[@]} -gt 0 ]]; then
  echo "FAIL (LIC-3): ${#missing_copyright[@]} file(s) missing SPDX-FileCopyrightText:" >&2
  printf '  %s\n' "${missing_copyright[@]}" >&2
  status=1
fi
if [[ ${#missing_license[@]} -gt 0 ]]; then
  echo "FAIL (LIC-4): ${#missing_license[@]} file(s) missing SPDX-License-Identifier:" >&2
  printf '  %s\n' "${missing_license[@]}" >&2
  status=1
fi
if [[ "$status" -eq 0 ]]; then
  echo "OK: $checked file(s) checked, all required SPDX headers present."
fi
exit "$status"
