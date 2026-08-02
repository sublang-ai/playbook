<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-026: Adapter SDKs as Optional Peer Dependencies

## Status

Accepted.
Reverses the install-closure mechanism chosen for
[RELEASE-12](../dev/release.md#release-12) — direct `dependencies` on
every wired adapter SDK — while keeping its goal: the adapters wired by
the bundled production config must actually load.
Breaking: an install that previously acquired both SDKs transitively no
longer does.

## Context

- `@sublang/playbook` declares `@anthropic-ai/claude-agent-sdk` and
  `@openai/codex-sdk` as regular runtime `dependencies`, purely so that
  a copy lands somewhere `@sublang/cligent` can resolve.
  No source file in this repository imports either SDK; cligent owns
  every adapter, and it declares the same three SDKs as **optional peer
  dependencies**, which npm never installs.
- The two packages therefore disagree about what the SDKs are, and the
  disagreement has two measured symptoms, reported as
  [sublang-ai/slc#6][3] and [sublang-ai/slc#1][4]:
  - **Footprint.** A documented install is 538 MB, of which ~466 MB
    (87%) is agent SDKs. Every user receives every stack: a Codex-only
    user downloads the whole Anthropic stack and vice versa.
  - **Unresolvability in the two-root global shape.** Naming
    `@sublang/playbook` as a *second* global root — the shape
    `npm install -g @sublang/slc @sublang/playbook` produces — puts the
    SDK inside `@sublang/playbook/node_modules/@anthropic-ai/`, a
    sibling subtree that Node's resolution can never reach from another
    root's nested cligent.
    Declaring the SDKs here does not fix that shape; it *causes* it.
- The mechanism failed because it targets the wrong layer. A hard
  dependency states "this package's code needs that module." Neither is
  true here: the SDKs are the user's *choice of agent vendor*, selected
  at config time, and they belong to whichever package the user
  installs deliberately.

## Decision

### 1. The SDKs become optional peer dependencies

`@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` move from
`dependencies` to `peerDependencies` with
`peerDependenciesMeta.<name>.optional = true` [[2]], matching cligent's
existing declaration exactly.
Their ranges are identical to cligent's own peer ranges — not merely
compatible: cligent is the only package that imports the SDKs, and a
narrower range here makes npm's resolver reject an application-owned
SDK version the loader accepts (`peerOptional` conflicts still fail
`npm install`), while a wider one admits versions the loader would
warn on.
`@sublang/cligent` and `@sublang/spex` stay regular `dependencies` —
this repository's code does import them, and cligent must keep nesting
inside `@sublang/playbook`'s module tree.

Both SDKs also become `devDependencies`, so the repository's own tests,
CI, and the local real-agent acceptance suite keep exercising real
adapters.

### 2. Layer rule: libraries declare, the installed root supplies

- `@sublang/cligent` is a library. It declares optional peers and
  demand-loads them. Unchanged.
- `@sublang/playbook` is a library plus a launcher. It declares
  optional peers. It never installs an SDK on the user's behalf.
- The **package the user installs deliberately** supplies the SDK. When
  `@sublang/playbook` is that package, the user names the SDK on the
  install line. When an application depends on Playbook, that
  application owns the choice and may pin an SDK outright.

This is the rule that keeps footprint proportional to the agents a user
actually configured, and it is the only rule under which a package
depending on Playbook can choose a different agent than Playbook's
seeded default.

### 3. A supplied SDK must be a top-level install root

Node resolves a bare specifier by walking directory ancestors and
appending `node_modules` [[1]]. From cligent's installed location inside a
global prefix — `<prefix>/lib/node_modules/@sublang/playbook/node_modules/@sublang/cligent/…`
— that walk passes through `<prefix>/lib/node_modules` itself.
So:

| SDK location | Resolves from a nested cligent |
| --- | --- |
| `<prefix>/lib/node_modules/@anthropic-ai/…` (its own root) | yes |
| `<prefix>/lib/node_modules/<other-root>/node_modules/@anthropic-ai/…` | no |
| hoisted flat in a project `node_modules/` | yes |

The documented global install therefore names the SDKs alongside the
package:

```sh
npm install -g @sublang/playbook @anthropic-ai/claude-agent-sdk @openai/codex-sdk
```

A user who edits the seeded config down to one vendor installs only
that vendor's SDK and pays only that stack's footprint.

The ephemeral `npx` / `npm exec` form follows the same rule with
different mechanics. npm materializes the run in a cache tree
(`…/_npx/<hash>/node_modules`, hoisted flat like a project install)
whose ancestor walk touches no global prefix, so **no install command
reaches it** — the only way to supply an SDK there is to name it as a
sibling package of the same invocation:

```sh
npx -y -p @sublang/playbook -p @anthropic-ai/claude-agent-sdk playbook
```

The preflight (§4) detects an exec-tree run and prints this re-run
form instead of an `npm install -g` line that would install somewhere
the tree cannot see.
The printed re-run names the SDK of every mapped adapter the lineup
requires, not only the missing ones — each distinct package set
materializes a distinct exec tree, so a missing-only list drops the
SDKs the current tree does have and the two partial trees alternate
forever — pins the running package's own version, and replays the
original arguments, so it is executable as printed and completes in
one hop.
Input the command already consumed from stdin (a `run` task, a
`resume` reply) is appended to the re-run behind a `--` end-of-options
terminator, quoted, because the pipe that carried it is gone when the
printed command runs and quoting alone cannot stop a flag-shaped value
(`--json`, `--last`, a `-`-leading bullet) from being reinterpreted as
an option; and any prerequisite external CLI install is printed before
the re-run, since the re-run probes the CLI again.

### 4. Missing SDKs fail at the gate, not mid-turn

Making the SDKs optional is only safe if their absence is diagnosed
before work starts. The launcher already owns an adapter readiness gate
([PBCLI-12](../dev/playbook-cli.md#pbcli-12)) that checks credentials;
it gains a second, independent check for SDK loadability, and the
non-interactive `run` path gains the same check over its bound agents
([PBCLI-39](../dev/playbook-cli.md#pbcli-39)).

The probe is cligent's own `adapter.isAvailable()`, imported from
cligent's installed location. That is deliberate: it performs exactly
the dynamic import the adapter will perform at run time, from exactly
the module scope that will perform it, so a passing probe cannot
disagree with a failing run.
Resolution-only alternatives were rejected — neither SDK exposes
`./package.json`, and `@openai/codex-sdk` is ESM-only, so
`createRequire(...).resolve()` reports both as missing when they are
present.

A blocked launch names each unavailable adapter and the exact command
that fixes it — `npm install -g <sdk>` for an installed tree, the §3
multi-package re-run for an exec tree, plus the global install of any
external CLI the adapter's probe also requires — so the remedy never
requires reading this record.
The probe map covers exactly the adapters backed by cligent's optional
peer SDKs (`claude`, `codex`, `opencode`); `gemini`'s transport SDK is
a regular dependency of cligent, so it has no missing-SDK failure mode
to gate.

### 5. The release gate moves to the shape users actually get

The CI smoke test asserts both install shapes ([RELEASE-13](../test/release.md#release-13)):

- **Lean** — the tarball alone. cligent nests under `@sublang/playbook`;
  neither SDK is present anywhere in the closure; both adapters probe
  as unavailable. This is the assertion that keeps the footprint fix
  from silently regressing.
- **Opted-in** — the tarball plus both SDKs as sibling roots. Both
  adapters probe as available *from cligent's installed location*.
  This is the assertion that keeps §3's documented command honest.

In-repository and project-local installs hoist the SDK flat and pass
either way, which is why no in-repository test ever caught the original
defect.

## Consequences

- Footprint becomes proportional: a single-vendor user pays one stack
  rather than three.
- `npm install -g @sublang/playbook` alone no longer yields a launchable
  install. It yields a *diagnosable* one — the gate names the missing
  SDK and its install line — but the documented command grows, and the
  README, `docs/cli.md`, and the seeded config comment must carry it.
- Existing global installs **break on an in-place upgrade** and must
  re-run the documented install line. Under the old declaration the SDK
  stacks nest inside `@sublang/playbook`'s own subtree — where the
  nested cligent could in fact resolve them — and `npm install -g` of
  the new version re-computes that root's tree against the new
  manifest and prunes everything the dropped dependencies pulled in
  (measured: upgrading a global 3.1.0 removed 104 packages, both SDK
  stacks among them). The upgrade command is therefore the same as the
  fresh install command: name the wanted SDKs alongside the package.
  There is no shape in which the old nested copy survives to satisfy
  the new peer declaration, so documentation must present this as a
  migration, not a compatibility.
- An application depending on `@sublang/playbook` must now declare an
  SDK itself. That is the intended transfer of ownership, and it is the
  precondition for fixing [sublang-ai/slc#1][4] in the application layer
  rather than working around it here.
- SemVer: removing dependencies other packages relied on transitively is
  breaking. The version bump is deliberately left to the release step
  ([RELEASE-4](../dev/release.md#release-4),
  [RELEASE-10](../dev/release.md#release-10)) rather than fixed here,
  because `4.0.0` is also the version [DR-023](023-data-only-machine-ir.md)
  names for the data-only machine IR direction, and sequencing those two
  is a release decision, not an implementation one.

## Alternatives rejected

- **Keep hard dependencies, fix resolution in cligent.** cligent cannot
  fix it: the SDK is genuinely absent from every directory on its
  resolution path in the sibling-root shape. Only installing the SDK
  where the walk passes fixes it, and that is an install-shape decision.
- **`optionalDependencies`.** npm attempts the install and tolerates
  only *failure*, not *choice* — every user would still download every
  stack. It solves neither symptom.
- **Bundle one SDK, peer the rest.** Restores the footprint problem for
  the bundled vendor and privileges one agent vendor in a package whose
  premise is that agents are interchangeable.
- **Probe by resolution instead of import.** Rejected in §4: both SDKs'
  `exports` maps make resolution-based probes report false negatives.

## References

[1]: https://nodejs.org/api/modules.html#loading-from-node_modules-folders 'Node.js — Loading from node_modules folders'
[2]: https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependenciesmeta 'npm — peerDependenciesMeta'
[3]: https://github.com/sublang-ai/slc/issues/6 'slc#6 — Install is 538 MB; every agent SDK stack ships regardless of chosen agent'
[4]: https://github.com/sublang-ai/slc/issues/1 'slc#1 — Documented global install cannot compile: agent adapter SDKs unresolvable'
