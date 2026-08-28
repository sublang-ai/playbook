// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { _testing } from '../scripts/release-smoke.mjs';

const calls = [
  ['first', 'closing', null, null, 'release-smoke-captain-a', 'low'],
  [
    'continued',
    'selection',
    null,
    'release-smoke:closing:first:1',
    'release-smoke-captain-a',
    'low',
  ],
  ['lane-a', 'player', 'first', null, 'release-player-a', 'high'],
  [
    'lane-a',
    'player',
    'second',
    'release-lane:shared:1',
    'release-second-a',
    'low',
  ],
  ['lane-a', 'player', 'isolated', null, 'release-player-a', 'high'],
  [
    'lane-a',
    'closing',
    null,
    'release-smoke:selection:continued:1',
    'release-smoke-captain-a',
    'low',
  ],
  [
    'lane-b',
    'player',
    'second',
    'release-lane:shared:2',
    null,
    null,
  ],
  [
    'lane-b',
    'player',
    'first',
    'release-lane:shared:3',
    'release-player-b',
    'max',
  ],
  [
    'lane-b',
    'player',
    'isolated',
    'release-lane:isolated:1',
    'release-player-b',
    'max',
  ],
  [
    'lane-b',
    'closing',
    null,
    'release-smoke:closing:lane-a:4',
    'release-smoke-captain-b',
    'max',
  ],
].map(([process, kind, role, resume, model, effort]) => ({
  process,
  kind,
  role,
  resume,
  model,
  effort,
}));

describe('deterministic packed release lane smoke', () => {
  it('constructs bundled runtimes with their current declared options', () => {
    const source = _testing.compiledRuntimeImportProbeSource();

    expect(source).toContain('runtime: reviewFactory({})');
    expect(source).toContain('runtime: decideFactory({})');
    expect(source).toContain("const adoptionMembers = ['adopt']");
    expect(source).toContain('absentMembers: adoptionMembers');
    expect(source).not.toContain('coderLlm');
    expect(source).not.toContain('reviewerLlm');
  });

  it('keeps distinct segmented ids equal-configured and retunes both', () => {
    const primary = parseYaml(_testing.smokeConfig('a'));
    const overlay = parseYaml(_testing.smokeRetuneOverlay());

    expect(primary.players['release.shared']).toEqual(
      primary.players['release.isolated'],
    );
    expect(primary.captain).toMatchObject({
      model: 'release-smoke-captain-a',
      effort: 'low',
    });
    expect(primary.players['release.shared']).toMatchObject({
      model: 'release-player-a',
      effort: 'high',
    });
    expect(primary.playbooks.lanes.roles.first).toBe('release.shared');
    expect(primary.playbooks.lanes.roles.isolated).toBe('release.isolated');
    expect(overlay.players['release.shared']).toEqual(
      overlay.players['release.isolated'],
    );
    expect(overlay.captain).toMatchObject({
      model: 'release-smoke-captain-b',
      effort: 'max',
    });
    expect(overlay.players['release.shared']).toMatchObject({
      model: 'release-player-b',
      effort: 'max',
    });
    expect(primary.playbooks.lanes.roles.second).toMatchObject({
      player: 'release.shared',
      model: 'release-second-a',
      effort: 'low',
    });
    expect(overlay.playbooks.lanes.roles.second).toMatchObject({
      player: 'release.shared',
      model: false,
      effort: false,
    });
  });

  it('pins both shared-role directions, isolated tokens, and current tuning', () => {
    expect(() => _testing.assertSmokeCalls(calls)).not.toThrow();

    for (const index of [3, 6, 7, 8]) {
      const mutated = structuredClone(calls);
      mutated[index]!.resume = 'mutated-token';
      expect(() => _testing.assertSmokeCalls(mutated)).toThrow(
        /shared\/isolated tokens and tuning/,
      );
    }
    for (const index of [3, 6, 7, 8, 9]) {
      const mutated = structuredClone(calls);
      mutated[index]!.model = 'mutated-model';
      expect(() => _testing.assertSmokeCalls(mutated)).toThrow(
        /shared\/isolated tokens and tuning/,
      );
    }
  });
});
