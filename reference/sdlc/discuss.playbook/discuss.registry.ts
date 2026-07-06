// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Registry entry for the DISCUSS playbook — the host-side adapter the generic
// `playbook` launcher loads via a config block's `from:` specifier. The three
// core artifacts beside this file (discuss.gears.md, discuss.fsm.ts,
// discuss.playbook.ts) were compiled by `slc playbook reference/sdlc/discuss.md`
// through slc's pinned compiled meta-phase playbooks and verified by slc's
// generated compilation-correctness tests; this entry is hand-written host
// infrastructure, out of slc's compile scope (slc DR-009).
//
// This module is loaded directly by Node's type stripping (it is not part of
// the package build), so it uses extension-bearing .ts imports and erasable
// syntax only.

import type { PlaybookRuntime } from '@sublang/playbook/runtime';

import createPlaybookRuntime from './discuss.playbook.ts';
import type { PlaybookRuntimeOptions } from './discuss.playbook.ts';

export interface RegistryPlayer {
  id: string;
  adapter?: string;
  model?: string;
}

export interface CreateDiscussRuntimeOptions {
  captainOptions: unknown;
  players: readonly RegistryPlayer[];
}

export interface DiscussOptions {
  /** Which alias alternative runs `Committer` commits; defaults to `host`. */
  committer?: 'host' | 'participant';
}

const DISCUSS_OPTION_KEYS = new Set(['committer']);
const COMMITTER_PLAYER_IDS = new Set(['host', 'participant']);

export function validateDiscussOptions(optionSlice: unknown): DiscussOptions {
  if (optionSlice === undefined) return {};
  if (
    typeof optionSlice !== 'object' ||
    optionSlice === null ||
    Array.isArray(optionSlice)
  ) {
    throw new Error(
      'captain.options.playbooks.discuss.options must be an object',
    );
  }
  const slice = optionSlice as Record<string, unknown>;
  for (const key of Object.keys(slice)) {
    if (!DISCUSS_OPTION_KEYS.has(key)) {
      throw new Error(
        `Unknown config field captain.options.playbooks.discuss.options.${key}`,
      );
    }
  }
  const options: DiscussOptions = {};
  const committer = slice.committer;
  if (committer !== undefined) {
    if (typeof committer !== 'string' || !COMMITTER_PLAYER_IDS.has(committer)) {
      throw new Error(
        "captain.options.playbooks.discuss.options.committer must be " +
          "'host' or 'participant'",
      );
    }
    options.committer = committer as 'host' | 'participant';
  }
  return options;
}

function playerIdentity(
  players: readonly RegistryPlayer[],
  id: string,
): string | undefined {
  const entry = players.find((p) => p.id === id);
  return entry?.model ?? entry?.adapter;
}

export function createDiscussRuntimeOptions({
  captainOptions,
  players,
}: CreateDiscussRuntimeOptions): PlaybookRuntimeOptions {
  const discussOptions = validateDiscussOptions(captainOptions);
  const options: PlaybookRuntimeOptions = {
    hostLlm: playerIdentity(players, 'host'),
    participantLlm: playerIdentity(players, 'participant'),
  };
  if (discussOptions.committer !== undefined) {
    options.players = { Committer: discussOptions.committer };
  }
  return options;
}

export const discussPlaybookRegistryEntry = {
  id: 'discuss',
  command: 'discuss',
  intent:
    'design discussion: two agents converge on spec items or decision records',
  requiredRoleIds: ['host', 'participant'],
  idleStateId: 'ready',
  finalStateId: 'done',
  parkStateIds: ['failed', 'awaitBossReply'],
  validateOptions: validateDiscussOptions,
  createRuntime(options: CreateDiscussRuntimeOptions): PlaybookRuntime {
    return createPlaybookRuntime(createDiscussRuntimeOptions(options));
  },
};

export default discussPlaybookRegistryEntry;
