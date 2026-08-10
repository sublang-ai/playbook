<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cross-references: Markdown Cross-References

## Intent

This project-local package specifies and verifies relative Markdown link and anchor resolution across `specs/`, `CHANGELOG.md`, and `README.md`.

## External Behavior

### Scope

#### cross-references-5

When checking repository Markdown, the checker shall scan every `.md` file under `specs/` plus root `CHANGELOG.md` and `README.md`, shall not descend into `.git`, `.claude`, `node_modules`, `dist`, `build`, or `coverage`, and shall allow a scanned link to target any file inside the repository.

#### cross-references-6

When interpreting a scanned document, the checker shall ignore link syntax inside fenced code blocks and inline code spans, raw HTML `<a href>` links, and targets carrying a URI scheme or beginning `//`, while treating a target beginning `/` as relative to the repository root.

#### cross-references-7

When computing a Markdown file's anchors, the checker shall use the GitHub heading-slug algorithm [[1]] over rendered heading text, suffix duplicate slugs with `-1`, `-2`, and so on in document order, and include every explicit HTML `id` or `name` value:

- Lowercase the rendered heading text, remove every character other than a letter, number, mark, space, hyphen, or underscore, and replace each remaining space with a hyphen.
- Preserve spaces left on both sides of a removed character, so `### 11. Host adapter — tmux-play` yields `11-host-adapter--tmux-play`.
- Treat Markdown links and raw HTML as their rendered text and inline code spans as their content, so `` ### `playbooks.<id>` routing `` yields `playbooksid-routing`.

### Resolution

#### cross-references-1

Where a link is selected by [[cross-references-5](#cross-references-5)] and not excluded by [[cross-references-6](#cross-references-6)], when the link carries a target path, the target
shall name a file that exists within the project directory.

#### cross-references-2

Where a link is selected by [[cross-references-5](#cross-references-5)], not excluded by [[cross-references-6](#cross-references-6)], and targets a Markdown file, when the link carries a `#` fragment, the fragment shall equal one of the anchors computed by [[cross-references-7](#cross-references-7)].

## Verification

### Resolution Checks

#### cross-references-3

When the test suite resolves every link in the selected files, the test suite shall fail
unless: each link that is not excluded and carries a target path
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
project root; and no file under a skipped directory is scanned (verifying [[cross-references-1](#cross-references-1)], [[cross-references-5](#cross-references-5)], [[cross-references-6](#cross-references-6)]).

#### cross-references-4

When the test suite resolves every `#` fragment in the selected files, the test suite shall fail
unless: each fragment on a markdown target equals one of that file's anchors; a fragment on a target
that is not markdown is accepted unresolved; two targets sharing a basename
resolve against their own file's anchors; a heading whose slug carries
repeated hyphens is matched only by the identical spelling, so that a
heading such as `### 11. Host adapter — tmux-play` rejects
`#11-host-adapter-tmux-play` and names `#11-host-adapter--tmux-play` as the
near miss; the second and third headings yielding one slug answer to `-1`
and `-2`; an explicit HTML `id` or `name` resolves as an anchor while the
same markup quoted in a code span does not; and a heading's code span
contributes its content rather than being read as syntax (verifying [[cross-references-2](#cross-references-2)], [[cross-references-5](#cross-references-5)], [[cross-references-6](#cross-references-6)], [[cross-references-7](#cross-references-7)]).

## References

[1]: https://github.com/Flet/github-slugger "github-slugger — the slug algorithm GitHub applies to headings"
