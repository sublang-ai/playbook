// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
const args = process.argv.slice(2);
if (args.length !== 3) {
  throw new Error(
    "Usage: node scripts/benchmark-repository-observation.mjs <baseline-package-root> <candidate-package-root> <new-output-directory>",
  );
}
const [baselineRoot, candidateRoot, root] = args.map((value) => resolve(value));
const packageRoots = { baseline: baselineRoot, candidate: candidateRoot };
await mkdir(root);
const exec = promisify(execFile);
const changePath = "reference/sdlc/code.playbook/bin/repository-effects.js";
const modules = Object.fromEntries(
  await Promise.all(
    ["baseline", "candidate"].map(async (name) => [
      name,
      await import(
        pathToFileURL(
          join(
            packageRoots[name],
            "reference/sdlc/code.playbook/host-capabilities.js",
          ),
        )
      ),
    ]),
  ),
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const identity = {
  changePath,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  scriptSha256: hash(await readFile(fileURLToPath(import.meta.url))),
  git: (await exec("git", ["--version"])).stdout.trim(),
  packages: {},
};
for (const [name, packageRoot] of Object.entries(packageRoots)) {
  const details = {
    repositoryEffectsSha256: hash(
      await readFile(join(packageRoot, changePath)),
    ),
    lockSha256: hash(await readFile(join(packageRoot, "pnpm-lock.yaml"))),
    packageVersion: JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ).version,
    gitRevision: null,
    dependencies: {},
  };
  try {
    const toplevel = (
      await exec("git", ["rev-parse", "--show-toplevel"], { cwd: packageRoot })
    ).stdout.trim();
    if (toplevel === packageRoot)
      details.gitRevision = (
        await exec("git", ["rev-parse", "HEAD"], { cwd: packageRoot })
      ).stdout.trim();
  } catch {
    /* Archived package trees need no Git metadata. */
  }
  for (const dep of [
    "typescript",
    "xstate",
    "vitest",
    "@sublang/cligent",
    "tmux-play",
  ]) {
    try {
      details.dependencies[dep] = JSON.parse(
        await readFile(
          join(packageRoot, "node_modules", dep, "package.json"),
          "utf8",
        ),
      ).version;
    } catch {
      details.dependencies[dep] = null;
    }
  }
  identity.packages[name] = details;
}
await writeFile(
  join(root, "identity.json"),
  JSON.stringify(identity, null, 2) + "\n",
);
const runRoot = await mkdtemp(join(root, "fixtures-"));
const rows = [];
const git = async (cwd, ...args) =>
  (
    await exec("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    })
  ).stdout.trim();
const timed = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
};
for (const profile of ["clean", "dirty-overlay"])
  for (const scenario of ["unchanged", "one-descendant-commit"]) {
    for (let iteration = -3; iteration < 20; iteration++) {
      const repo = join(runRoot, `${profile}-${scenario}-${iteration + 3}`);
      await mkdir(repo);
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "config", "user.email", "benchmark@example.invalid");
      await git(repo, "config", "user.name", "Deterministic Benchmark");
      for (let i = 0; i < 100; i++)
        await writeFile(join(repo, `tracked-${i}.txt`), `fixture ${i}\n`);
      await git(repo, "add", "--all");
      await git(repo, "commit", "-qm", "base");
      if (profile === "dirty-overlay") {
        for (let i = 0; i < 10; i++)
          await writeFile(
            join(repo, `untracked-${i}.txt`),
            "untracked baseline\n",
          );
        for (let i = 0; i < 10; i++)
          await writeFile(join(repo, `tracked-${i}.txt`), "dirty baseline\n");
      }
      const order =
        iteration % 2 === 0
          ? ["baseline", "candidate"]
          : ["candidate", "baseline"];
      const observations = {};
      const timings = { baseline: {}, candidate: {} };
      for (const name of order) {
        const r = await timed(() => modules[name].observeGitRepository(repo));
        observations[name] = r.value;
        timings[name].observeMs = r.ms;
      }
      assert.deepEqual(observations.baseline, observations.candidate);
      let expectedCommit;
      if (scenario === "one-descendant-commit") {
        await writeFile(
          join(repo, "implementation.txt"),
          "one source-owned change\n",
        );
        await git(repo, "add", "implementation.txt");
        await git(repo, "commit", "-qm", "implementation");
        expectedCommit = await git(repo, "rev-parse", "HEAD");
      }
      const receipts = {};
      for (const name of [...order].reverse()) {
        const r = await timed(() =>
          modules[name].captureRepositoryReceipt(observations[name], {
            allowedDispositions:
              scenario === "unchanged"
                ? ["unchanged"]
                : ["one-descendant-commit"],
          }),
        );
        receipts[name] = r.value;
        timings[name].captureMs = r.ms;
        timings[name].totalMs = timings[name].observeMs + r.ms;
        assert.equal(r.value.classification, scenario);
        assert.deepEqual(r.value.baseline, observations[name]);
        assert.ok(Object.isFrozen(r.value));
        assert.ok(Object.isFrozen(r.value.after));
        if (expectedCommit) assert.equal(r.value.commitOid, expectedCommit);
      }
      assert.deepEqual(receipts.baseline, receipts.candidate);
      rows.push({
        profile,
        scenario,
        iteration,
        warmup: iteration < 0,
        order,
        timings,
        baselineHead: observations.baseline.head,
        afterHead: receipts.baseline.after.head,
        receiptSha256: hash(JSON.stringify(receipts.baseline)),
        equalReceipts: true,
      });
    }
    console.log(`finished ${profile} ${scenario}`);
  }
const median = (a) => {
  a = [...a].sort((x, y) => x - y);
  return (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2;
};
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const summaries = [];
for (const profile of ["clean", "dirty-overlay"])
  for (const scenario of ["unchanged", "one-descendant-commit"]) {
    const selected = rows.filter(
      (r) => r.profile === profile && r.scenario === scenario && !r.warmup,
    );
    const totals = (name) => selected.map((r) => r.timings[name].totalMs);
    const base = totals("baseline"),
      candidate = totals("candidate"),
      deltas = base.map((v, i) => v - candidate[i]);
    summaries.push({
      profile,
      scenario,
      n: selected.length,
      baselineMedianMs: median(base),
      candidateMedianMs: median(candidate),
      baselineMeanMs: mean(base),
      candidateMeanMs: mean(candidate),
      pairedMedianSavedMs: median(deltas),
      pairedMeanSavedMs: mean(deltas),
      pairedWins: deltas.filter((v) => v > 0).length,
      medianRatio: median(candidate.map((v, i) => v / base[i])),
      medianPairedReductionPercent: median(
        candidate.map((v, i) => 100 * (1 - v / base[i])),
      ),
    });
  }
const evidence = {
  createdAt: new Date().toISOString(),
  identity,
  scope:
    "Exported public host-capability observeGitRepository plus captureRepositoryReceipt; excludes Git setup, implementation commit execution, claim acquisition, durable ledger/checkpoint writes, provider calls and workflow orchestration.",
  method: {
    freshFixturePerPair: true,
    trackedFiles: 100,
    dirtyOverlay: { trackedEdits: 10, untrackedFiles: 10 },
    sequentialPairs: true,
    alternatingFirstObservation: true,
    oppositeCaptureOrder: true,
    warmupPerCase: 3,
    measuredPairsPerCase: 20,
    twoOrderedSamplesPreserved: true,
  },
  summaries,
  rows,
};
await writeFile(
  join(root, "evidence.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(summaries, null, 2));
