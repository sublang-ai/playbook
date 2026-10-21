<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-090: Every Role Hears the Boss

## Status

Accepted (2026-10-12).
Amends [DR-005](005-boss-reply-suspension-path.md) §2 in one scope: the resumed call's question and answer blocks carry language-neutral markers instead of English labels, and every later call of the run carries the run's exchanges as well.
Amends [DR-088](088-a-commit-outcome-takes-every-new-commit.md) §3 in two scopes: a step's commit statement names the branch its commits landed on, and a step's one new commit reaches the closing reply's facts; the reply shows each step as a marked line.
Amends [DR-063](063-failures-explain-themselves.md) §4 and [DR-089](089-judge-replies-take-the-machines-shapes.md) §3 in one scope: the failure, control and commits-before-failure lines the shell appends to a reply carry marks and identifiers instead of English sentences; the settlement facts keep their words.
Source-required retention under [[compiler-source-state-2](../packages/compiler-source-state.md#compiler-source-state-2)] stands as the stronger guarantee.

## Context

A walk of ten teams through the 17.8.1 build (2026-10-12) found four gaps:

- A reviewing role never saw the Boss's answers.
  One team's Lead said "第一轮我手上只有分析师自己的说法，没看到产品经理的答复"; another's said "That answer's text isn't in my input".
  A reply reached only the asking role's continuation, and a later role only where the Source asked to retain it; neither team's Source did, and each lost a review round.
- In a Chinese run the continuation reached the player as English sentences: "Continue the same task using Boss’s reply below.", "Your previous question:", "Boss reply:".
- A committed run's closing reply left out the commit's hash ("saved in one new commit on the current branch") and its branch ("放到当前分支", on a branch that was not `main`).
  The outcome report carried no hash for a step's single commit, and no receipt named a branch.
- A player's commit trailer named its model "GPT-6 (coder)" for `gpt-6.1-sol` in an analyst's step: nothing told the player its role or its model.
- A Chinese team's failed run ended its Chinese closing reply with the shell's fixed English lines: "Repository changes made before the failure:", "- A step made one new commit; HEAD moved from … to the proven commit …", "The failure does not undo these commits.", "Failure: The acting player returned an unrecognized or incomplete result.", "Controls:", "- Stop /sprint-plan (ready)".

Considered and declined:

- Leaving Boss context to Source authors: two of ten Sources did not ask, and a reviewer cannot ask for what it was never told.
- Relaying only the latest exchange: a second review round needs the first round's answer.
- Translating the labels into the run's language: the runtime does not know that language, and markers need none.
- Reading the branch when the reply is composed: HEAD may have moved since the step; the step's own after observation is the evidence.

## Decision

1. **Every player call hears the run's Boss exchanges.**
   - A run begins when the runtime sends the artifact's deterministic or classified initial entry event or restarts a finished machine. A classified entry from failure resets the exchanges; a reply, a global interrupt alone, or a refused event does not.
   - Each Boss reply the machine receives for a pending question appends one exchange: the question as asked and the reply verbatim.
   - Every player call after the run's first exchange carries every exchange so far, in order, after its role line and before its body, whatever its role and whatever its Source retains.
   - The asking role's continuation keeps its own question and reply blocks and reads that exchange there, not twice.
   - The exchanges travel in the runtime snapshot, so a restored or adopted run keeps them; a snapshot without them heard none.
   - They are runtime context, not Source history: Source-required retention keeps its own relevance, format and lifecycle.
2. **Markers, not sentences.**
   A line `? ⟶` precedes each question and a line `Boss ⟶` each reply, in the exchange block and the continuation blocks alike, with no other framing words.
   A Chinese or an English player reads them as structure, not as a foreign instruction.
3. **The prompt names the role and the model.**
   Every player prompt's first block reads `Role: <role> · Model: <model>`: the local role the machine names and the model the host's binding configures, its prompt identity.
   A runtime without bindings names the role alone.
   A commit trailer the project's Git spec asks for can then name both.
4. **The closing reply names each commit and its branch.**
   - The repository observation records the branch HEAD names, absent for a detached HEAD or a directory that is not a repository yet; no comparison of two observations reads it.
   - A step's commit statements name that branch: DR-088 §3's statements and the commits-before-failure statement of [DR-089](089-judge-replies-take-the-machines-shapes.md) §3.
   - A step's one new commit joins the closing reply's facts as `The step made one new commit, <oid>, on branch <branch>.`; it is not appended to the reply, and a failed turn states it once, in its commits-before-failure report.
   - The closing-reply prompt names each commit by its hash and its branch as the report gives them.
5. **The shell's own lines carry marks, not sentences.**
   The lines the shell appends to a reply read as structure in any language, while the model's closing reply, which speaks the Boss's language, explains them from the settlement facts, whose words stay:
   - a step's commits read `✓ <commits> ⎇ <branch>`, a commit already at HEAD `✓ = <head> ⎇ <branch>`, and commits before a failure `✓ <baselineHead> ⟶ <commits> ⎇ <branch>`;
   - the failure line reads `✕ <code>` and the identities its cause carries — role, nested playbook, heads, commit, paths — joined by ` · `, and no recorded reason or message, so nothing the shell would withhold reaches it;
   - each control reads `▸ <label>`, or `▹ <label> · <standing> · <reason>` where it is not ready, by the closed standing and reason identifiers.

## Consequences

- Every player prompt begins with the role line, and calls after a Boss reply grow by the run's exchanges.
- Compiled artifacts need no recompilation: their composers call the shared continuation helper, and the runtime adds the role line and the exchanges around their result.
- A Playbook release before this one rejects a runtime snapshot carrying `bossExchanges` and a ledger whose observations carry `branch`; hosts sharing a session store upgrade together.
- A single commit's hash and branch reach the Boss through the closing reply the model composes; the appended report still states more than one commit and the commit already at HEAD.
- Source-owned retention, such as DEV's discussion history, keeps its own words; only the runtime's framing changes.
- A compiled artifact's composer keeps the labelled continuation slc's prompt-contract verifier pins; the runtime hands a composer no question and reply and marks them itself, so the verifier of an installed slc keeps passing.
- A nested playbook runs its own run: the parent's exchanges reach it only through the text the parent hands off.
- A failure line no longer states the reason in words; the closing reply states it from the facts, and a shell-composed fallback reply lists the facts in English.
- Still English after this decision: the unresolved-effect, carried-changes and resumption reports, the fallback and give-up replies, the shell's own `Stop <command>` label and the runtime's action labels such as `Retry: …`.
