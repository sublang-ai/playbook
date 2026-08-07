<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# XREF: Markdown Cross-References

## Intent

This spec defines acceptance tests for markdown cross-reference resolution
across this repository's [checked
files](../dev/cross-references.md#checked-files).

## Resolution Checks

### XREF-3
Verifies: [XREF-1](../dev/cross-references.md#xref-1)

When the test suite resolves every link in the [checked
files](../dev/cross-references.md#checked-files), the test suite shall fail
unless: each link that is not
[excluded](../dev/cross-references.md#exclusions) and carries a target path
names a file that exists within the project directory, reported with the
citing file, its line, and the literal target; a target resolving outside
the project directory is reported as a failure rather than accepted from a
neighboring checkout; a link inside a fenced code block or an inline code
span is not resolved, while a link whose text is a code span still is; a
target carrying a URI scheme or beginning `//` is not resolved; a link
carrying a title in any of the three quoting styles is resolved, and one
written as a reference definition is resolved at its own line; a
percent-encoded target is decoded before resolution and a malformed escape
is reported rather than raised; a target beginning `/` resolves from the
project root; and no file under a skipped directory is scanned.

### XREF-4
Verifies: [XREF-2](../dev/cross-references.md#xref-2)

When the test suite resolves every `#` fragment in the [checked
files](../dev/cross-references.md#checked-files), the test suite shall fail
unless: each fragment on a markdown target equals one of that file's
[anchors](../dev/cross-references.md#anchor-slugs); a fragment on a target
that is not markdown is accepted unresolved; two targets sharing a basename
resolve against their own file's anchors; a heading whose slug carries
repeated hyphens is matched only by the identical spelling, so that a
heading such as `### 11. Host adapter — tmux-play` rejects
`#11-host-adapter-tmux-play` and names `#11-host-adapter--tmux-play` as the
near miss; the second and third headings yielding one slug answer to `-1`
and `-2`; an explicit HTML `id` or `name` resolves as an anchor while the
same markup quoted in a code span does not; and a heading's code span
contributes its content rather than being read as syntax.
