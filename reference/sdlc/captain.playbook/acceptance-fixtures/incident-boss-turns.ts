// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// A29-1 fixture (IR-036 §Acceptance plan, "Fixture provenance"): the four
// Boss turns of the motivating session replayed by the incident-replay row.
//
// Provenance rule (IR-036): turn 1 is recorded verbatim in DR-029 §Context.
// Turns 2-4 could not be recovered from the motivating session's log, so
// they are recorded here as marked RECONSTRUCTIONS and the fixture's
// verbatim guarantee is scoped to turn 1. The reconstruction follows the
// one fact DR-029 §Context does pin about them — "'Retry and continue the
// iteration' from `failed` produced `NO_ACTION` four times in a row" — so
// the reconstructed turns repeat that same request rather than inventing
// wording the log does not support.
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

/** The one turn the fixture guarantees verbatim (DR-029 §Context). */
export const INCIDENT_VERBATIM_TURN = INCIDENT_BOSS_TURNS[0];
