<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# XREF: Markdown Cross-References

## Intent

This spec defines how relative links between markdown documents resolve, so
that a cross-reference cannot rot into a dead link without notice.

Its one project-specific commitment is the set of documents it governs: this
repository's `specs/` tree plus the root `CHANGELOG.md` and `README.md`, as
listed under [Checked Files](#checked-files). Markdown elsewhere in the
repository is out of scope.

## Scope

### Checked Files

Every `.md` file under `specs/`, plus `CHANGELOG.md` and `README.md` at the
project root. Directories named `.git`, `.claude`, `node_modules`, `dist`,
`build`, and `coverage` are not descended into.

A link's target is in scope wherever inside the repository it points,
including at files outside this set.

### Exclusions

The following carry no links for the purposes of this spec, because
documents quote link syntax as prose:

- text inside a fenced code block;
- text inside an inline code span.

A target is also out of scope when it carries a URI scheme (e.g. `https:`,
`mailto:`) or begins with `//`. Links written as raw HTML `<a href>` are not
governed by this spec.

A target beginning `/` is taken as relative to the project root.

### Anchor Slugs

A heading's anchor is the slug GitHub derives from its rendered text
[[1]]: lowercased, with every character that is not a letter, number, mark,
space, hyphen, or underscore removed, and each remaining space replaced by a
hyphen. Where two headings in one file yield the same slug, the first keeps
it and each later one takes a `-1`, `-2`, … suffix in document order.

A removed character standing between two spaces leaves both spaces behind,
so `### 11. Host adapter — tmux-play` yields `11-host-adapter--tmux-play`,
with two hyphens.

Rendered text is what the reader sees, so markdown link and raw-HTML syntax
in a heading contributes only its text, while an inline code span
contributes its content verbatim: `` ### `playbooks.<id>` routing `` yields
`playbooksid-routing`.

A file's anchors are its heading slugs together with the `id` or `name`
value of every explicit HTML anchor it contains.

## Resolution

### XREF-1

Where a link in a [checked file](#checked-files) is not
[excluded](#exclusions), when the link carries a target path, the target
shall name a file that exists within the project directory.

### XREF-2

Where a link in a [checked file](#checked-files) is not
[excluded](#exclusions) and its target names a markdown file, when the link
carries a `#` fragment, the fragment shall equal one of that file's
[anchors](#anchor-slugs).

## References

[1]: https://github.com/Flet/github-slugger "github-slugger — the slug algorithm GitHub applies to headings"
