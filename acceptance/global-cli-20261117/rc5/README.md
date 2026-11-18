<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# rc5 module revision evidence

Candidate `@sublang/playbook@19.1.0-rc.5` supersedes the earlier rc4 module-cache observations for this fix. Full required `pnpm@9 test` completed with 3,092 passing tests and 34 existing skips in its first invocation, then 156 passing release-capability tests: **3,248 passed, 34 skipped, exit 0**. The final prepush also exits 0; existing spec warnings remain in the raw log. Both command receipts bind the same unchanged source/dist inventory. The earlier full-suite failure from an RC metadata assertion is retained separately; it is not represented as a successful run.

The native CJS review archive contains 58 recorded commands against the actual production JavaScript helper, including Node 25.5 and 26.13.1 three-hop literal `require`/`module.require` reexports, old/new simultaneous callbacks and cycles, JSON/ESM sharing, explicit CommonJS `.js` and `.cts`, native errors and unsupported no-scope boundaries. Its assessment distinguishes instrumented traces from direct product checks. Permanent artifact-environment tests include the actual 1→999 manifest/reload chain and public host marker variants. Source file hashes and exact commands are inside each record.

ESM `import.meta` URL/filename are logical revision aliases; their directory and canonical registry locator remain physical. CJS lexical names remain physical. Unscoped ambiguous `.js` preparse without a determined format is conservatively refused. These explicit boundaries are recorded in artifact-environment-7 and DR-110; this archive does not claim complete native Node interoperability or cross-OS approval.

Raw streams and inventories are gzip-compressed without changing decompressed bytes. `SHA256.json` records raw/compressed hashes. The frozen rc5 npm tarball is `f7339a42cb0219d5a5c1d0b6a48778f26c901435f7b9eed5b24fdd8547e2720d`, retained in the delivery workspace alternative registry. Public npm acquisition and exact-head required CI remain separate release gates; no merge or public release is authorized by these local passes alone.

An additional focused managed foreign-live-link case passes after the full suite: it first prepares an accepted owned environment, replaces only XState with a live foreign link, then asserts an actionable environment refusal and unchanged metadata, both link targets and foreign bytes. Product package bytes are unchanged; this is one separately recorded test, not a retrospectively increased full-suite count.
