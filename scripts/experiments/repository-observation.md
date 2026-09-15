<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Repository Observation Performance

The retained change overlaps three independent Git reads inside each repository-observation sample.
Two consecutive complete samples, content identities, failure precedence, receipt classification, cooperative claims and durable checkpoint behavior are preserved.
It implements the existing [observation contract](../../specs/packages/playbook-runtime.md#playbook-runtime-67) without a new public behavior or API.

## Measured result

The maintained benchmark replay saves a median 116–133 ms per complete baseline-observation plus receipt-capture pair on the measured fixtures.
This is a repository-observation result; model execution, implementation commit execution, claim acquisition, effect-ledger writes, checkpoint persistence and whole-workflow time are outside the timed region.

| Fixture       | Receipt               | Baseline median ms | Candidate median ms | Median paired saving ms | Median paired reduction | Wins / pairs |
| ------------- | --------------------- | -----------------: | ------------------: | ----------------------: | ----------------------: | -----------: |
| clean         | unchanged             |             229.71 |              114.48 |                  115.97 |                  50.24% |        20/20 |
| clean         | one-descendant-commit |             277.81 |              160.40 |                  118.71 |                  43.28% |        20/20 |
| dirty-overlay | unchanged             |             287.46 |              161.08 |                  133.44 |                  47.40% |        19/20 |
| dirty-overlay | one-descendant-commit |             309.49 |              186.94 |                  119.73 |                  40.49% |        19/20 |

An earlier separate replay of the same implementation saved 134–153 ms per pair (41–48%, 79/80 wins).
The maintained-script replay won 78/80 pairs; all 160 measured pairs across both runs produced identical full observations and receipts between baseline and candidate.
Absolute times varied between runs, so the comparisons use paired cases within each run and establish no general filesystem, repository-size or provider-speed guarantee.

## Method and identities

Both runs use three excluded warmup pairs and twenty measured pairs per case, one fresh private Git repository per pair, and 100 tracked files.
Dirty-overlay fixtures retain ten changed tracked files and ten untracked files across the operation.
Baseline and candidate execute sequentially; observation order alternates and receipt-capture order reverses it.
One-commit cases make exactly one real commit between baseline and after observations, outside timing, and check the exact receipt OID.
No model was called, and this task ran no regression suite concurrently with its measurements; unrelated machine activity was not controlled.

The baseline is exact Git revision `a000e37815024acc8051855adda72fcedbbfcedb`.
The integration parent is `677a9ea21f902a256f2b34957512374daae5fd1b`; its observer and dependencies match the private baseline.
Observer SHA-256 changes from `ff8955e5203d9719d6c00e5ae9b64921810a07204ea45a58972f214079a85716` to `3ba90976a6d23e08448ee63125edbdbfd1074c2c8c8c6d26cc33e1160dc46dc5`.
The [sanitized evidence](repository-observation-evidence.json) records both runs, individual paired timings, script hashes, lock hashes and actual dependency versions.
The measured platform is macOS arm64 with Node 25.5.0 and Apple Git 2.50.1; archived package copies share the same installed dependency tree.

## Reproduce

Run from this repository with its installed dependencies; choose a new output path that does not already exist.

```sh
observation_repo="$PWD"
observation_baseline=$(mktemp -d /private/tmp/playbook-observe-base.XXXXXX)
git archive a000e37815024acc8051855adda72fcedbbfcedb | tar -x -C "$observation_baseline"
ln -s "$observation_repo/node_modules" "$observation_baseline/node_modules"
node scripts/benchmark-repository-observation.mjs "$observation_baseline" "$observation_repo" /private/tmp/playbook-observation-new-run
```

The script imports the actual public host-capability functions from both package roots, creates fresh synthetic repositories, verifies complete receipt equality and writes timing evidence with implementation identities.
Archived roots have no Git metadata, so their observer hash and the explicitly recorded archive revision establish baseline provenance.

## Verification

The private candidate and the integration candidate both pass all 85 real-Git tests in `repository-effects.test.ts` and `host-capabilities.facade.test.ts`; the integration run takes 39.15 seconds.
The matrix covers unstable observations, index flags, content/mode changes, claim and stale-owner races, pre-aborted calls, durable acknowledgement failures, unchanged cohorts and deferred checkpoint mismatch/restoration.
Both full samples remain ordered, and `Promise.allSettled` waits for every read before publishing success or failure while preserving HEAD, index-read, index-visibility, then status error precedence.
The observer still makes no claim to identify or exclude every nonparticipating foreign writer.
Two independent source reviews and an independent recomputation of all paired summaries found no actionable issue.

```sh
node node_modules/vitest/vitest.mjs run reference/sdlc/code.playbook/repository-effects.test.ts reference/sdlc/code.playbook/host-capabilities.facade.test.ts --maxWorkers=1 --no-file-parallelism
```
