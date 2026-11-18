// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export function releaseChannel(tag, version) {
  if (
    !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/.test(
      tag,
    ) ||
    tag !== `v${version}`
  )
    throw new Error(
      'release tag must exactly match package version (stable or rc.N)',
    );
  return tag.includes('-rc.') ? 'rc-global-cli' : 'latest';
}
export function authorizedCandidatePull(pulls, repo, sha) {
  return pulls.find(
    (pr) =>
      pr.state === 'open' &&
      pr.base?.ref === 'main' &&
      pr.base?.repo?.full_name === repo &&
      pr.head?.repo?.full_name === repo &&
      pr.head?.sha === sha,
  );
}
export function passingReleaseRun(runs, { candidate, repo, sha, pr }) {
  const matching = runs
    .filter(
      (run) =>
        run.head_sha === sha &&
        run.head_repository?.full_name === repo &&
        (candidate
          ? run.event === 'pull_request' &&
            run.head_branch === pr.head.ref &&
            (!run.pull_requests?.length || run.pull_requests.some((pull) => pull.number === pr.number))
          : run.event === 'push' && run.head_branch === 'main'),
    )
    .sort(
      (a, b) =>
        Date.parse(b.created_at) - Date.parse(a.created_at) ||
        b.run_attempt - a.run_attempt,
    );
  return (
    matching[0]?.status === 'completed' && matching[0]?.conclusion === 'success'
  );
}
async function main() {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const tag = process.env.GITHUB_REF_NAME;
  const channel = releaseChannel(tag, manifest.version);
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha || !process.env.GH_TOKEN)
    throw new Error('release source gate requires GitHub identity and token');
  const api = async (path) => {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/${path}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok)
      throw new Error(`GitHub source gate HTTP ${response.status}`);
    return response.json();
  };
  const candidate = channel !== 'latest';
  const pr = candidate
    ? authorizedCandidatePull(
        await api(`commits/${sha}/pulls?per_page=100`),
        repo,
        sha,
      )
    : undefined;
  if (candidate && !pr)
    throw new Error(
      'candidate must be the fixed current head of an open same-repository PR targeting main',
    );
  for (let attempt = 0; attempt < 60; attempt++) {
    const data = await api(
      `actions/workflows/ci.yml/runs?head_sha=${sha}&event=${candidate ? 'pull_request' : 'push'}&per_page=100`,
    );
    if (passingReleaseRun(data.workflow_runs, { candidate, repo, sha, pr })) {
      console.log(
        JSON.stringify({
          sha,
          tag,
          channel,
          pullRequest: pr?.number,
          ci: 'success',
        }),
      );
      return;
    }
    if (attempt < 59) await setTimeout(10_000);
  }
  throw new Error(
    'no successful required CI for this exact authorized release head',
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
