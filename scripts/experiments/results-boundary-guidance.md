<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

A `Results:` block continues until the next item or section heading; after the label, emit only result bullets and blank lines.
An action item carries nothing but its statement, its prompt blockquote, and its `Results:` block: state its other conditions and invariants as requirement items, never as prose before the blockquote, between the blockquote and `Results:`, or after its bullets.
Nested-call items remain without `Results:`, and what follows the child's return is stated by requirement items that cite the call item.
