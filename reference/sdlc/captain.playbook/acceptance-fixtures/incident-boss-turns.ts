// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Incident-replay fixture: turn 1 is the verbatim motivating request.
// Turns 2-4 could not be recovered from the original session log, so they are
// explicitly marked as reconstructions and repeat that request without
// inventing different wording.
//
// This directory sits outside the `tsconfig.json` include globs on purpose:
// it is test-fixture data, so it emits no compiled sibling and is not part
// of the published artifact set.

export type IncidentTurnProvenance = 'verbatim' | 'reconstruction';

export interface IncidentBossTurn {
  /** 1-based position in the replayed session. */
  readonly turn: number;
  /** Exactly what the Boss typed, for `verbatim` turns. */
  readonly text: string;
  readonly provenance: IncidentTurnProvenance;
}

export const INCIDENT_BOSS_TURNS: readonly IncidentBossTurn[] = [
  {
    turn: 1,
    text: 'Retry and continue the iteration',
    provenance: 'verbatim',
  },
  {
    turn: 2,
    text: 'Retry and continue the iteration',
    provenance: 'reconstruction',
  },
  {
    turn: 3,
    text: 'Retry and continue the iteration',
    provenance: 'reconstruction',
  },
  {
    turn: 4,
    text: 'Retry and continue the iteration',
    provenance: 'reconstruction',
  },
];

/** The one turn the fixture guarantees verbatim. */
export const INCIDENT_VERBATIM_TURN = INCIDENT_BOSS_TURNS[0];
