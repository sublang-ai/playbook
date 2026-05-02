// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createActor, fromPromise } from 'xstate';

import {
  codingMachine,
  type CaptainInput,
  type CaptainOutput,
  type CodingEvent,
} from './coding.fsm';
import {
  createSketchInspector,
  fromXStateActor,
  mountSketch,
  type DisambiguateFn,
  type SketchMount,
} from '../src/sketch';

interface BossButton {
  label: string;
  event: CodingEvent;
}

const BOSS_BUTTONS: BossButton[] = [
  { label: 'START_CODING', event: { type: 'START_CODING', intent: 'demo intent' } },
  { label: 'IMPLEMENT_IR', event: { type: 'IMPLEMENT_IR', irNumber: '002' } },
  { label: 'CONTINUE_IR', event: { type: 'CONTINUE_IR', irNumber: '002' } },
  { label: 'REVIEW_COMMIT', event: { type: 'REVIEW_COMMIT' } },
  { label: 'REVIEW_CHANGES', event: { type: 'REVIEW_CHANGES' } },
  { label: 'COMMIT_CHANGES', event: { type: 'COMMIT_CHANGES' } },
  { label: 'PUSH_MILESTONE', event: { type: 'PUSH_MILESTONE', irNumber: '002' } },
  { label: 'SUMMARIZE_IR', event: { type: 'SUMMARIZE_IR', irNumber: '002' } },
  { label: 'REVIEW_SPECS', event: { type: 'REVIEW_SPECS', irNumber: '002' } },
];

// Allowed Captain guards per invoking state, mirroring each invoke's `result`
// map in coding.fsm.ts. The demo disables Captain buttons that the active
// state's onDone has no branch for; otherwise XState would consume the done
// event without firing any transition and the demo would wedge.
const CAPTAIN_GUARDS_BY_STATE: Record<string, readonly string[]> = {
  planAndImplement: ['singleCommitCommitted', 'iterationCommitted', 'needsBossInput'],
  implementIr: ['taskCommitted', 'changesReadyForReview', 'iterationDone', 'needsBossInput'],
  continueIr: ['taskCommitted', 'changesReadyForReview', 'iterationDone', 'needsBossInput'],
  reviewCodeCommit: ['noFindings', 'hasFindings'],
  reviewCodeChanges: ['noFindings', 'hasFindings'],
  respondToReview: ['changesMade', 'challengesRaised', 'readyToCommit'],
  adjudicateChallenges: [
    'challengeAccepted',
    'challengeRejected',
    'changesNeedReview',
    'noOpenItems',
  ],
  commitChanges: ['committed', 'noRelevantChanges', 'needsBossInput'],
  pushMilestone: ['ciPassed', 'ciFailed', 'flakyRerunStarted', 'pushedNoCi'],
  reviewCiFailure: ['fixNeeded', 'flaky', 'noAction'],
  rerunCi: ['flakyRerunStarted', 'needsBossInput'],
  fixCi: ['fixCommittedNoPush', 'needsBossInput'],
  summarizeSpecs: ['specsReadyForReview', 'noSpecChangesNeeded', 'needsBossInput'],
  reviewSpecChanges: ['noFindings', 'hasFindings'],
};

const ALL_CAPTAIN_GUARDS: readonly string[] = [
  ...new Set(Object.values(CAPTAIN_GUARDS_BY_STATE).flat()),
];

function activeStateLeafIds(snapshot: { value: unknown }): string[] {
  function recurse(v: unknown, prefix: string): string[] {
    if (typeof v === 'string') return [prefix ? `${prefix}.${v}` : v];
    if (typeof v === 'object' && v !== null) {
      const out: string[] = [];
      for (const [k, sub] of Object.entries(v)) {
        out.push(...recurse(sub, prefix ? `${prefix}.${k}` : k));
      }
      return out;
    }
    return [];
  }
  return recurse(snapshot.value, '');
}

function allowedGuardsFor(snapshot: { value: unknown }): Set<string> {
  const allowed = new Set<string>();
  for (const leaf of activeStateLeafIds(snapshot)) {
    const local = leaf.split('.').pop() ?? leaf;
    const list = CAPTAIN_GUARDS_BY_STATE[local];
    if (list) for (const g of list) allowed.add(g);
  }
  return allowed;
}

// Maps the planAndImplement onDone guards to the order they appear in the
// machine source. Used by the demo's `disambiguate` to pick a single edge
// when XState's onDone resolves the ambiguity locally.
const PLAN_GUARD_BRANCH_INDEX: Record<string, number> = {
  singleCommitCommitted: 0,
  iterationCommitted: 1,
  needsBossInput: 2,
};

const disambiguateByGuard: DisambiguateFn = (_prev, _event, next, candidates) => {
  const guard = (next as { context?: { lastResult?: { guard?: string } } } | null)
    ?.context?.lastResult?.guard;
  if (!guard) return candidates;
  const branchIndex = PLAN_GUARD_BRANCH_INDEX[guard];
  if (branchIndex === undefined) return candidates;
  const matched = candidates.find((id) => {
    const parts = id.split('::');
    const branchPart = parts[parts.length - 2];
    return branchPart === String(branchIndex);
  });
  return matched ?? candidates;
};

function createButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function createGroup(title: string, modifier?: string): HTMLElement {
  const group = document.createElement('section');
  group.className = 'sketch-controls__group';
  if (modifier) group.classList.add(modifier);
  const heading = document.createElement('h2');
  heading.textContent = title;
  group.appendChild(heading);
  return group;
}

export interface CodingDemoMount {
  dispose(): void;
}

export interface CodingDemoOptions {
  canvas: HTMLElement;
  controls: HTMLElement;
}

export function startCodingDemo(opts: CodingDemoOptions): CodingDemoMount {
  let pendingCaptain: ((output: CaptainOutput) => void) | null = null;

  const Captain = fromPromise<CaptainOutput, CaptainInput>(
    () =>
      new Promise<CaptainOutput>((resolve) => {
        pendingCaptain = resolve;
      }),
  );

  const inspector = createSketchInspector();
  const machine = codingMachine.provide({
    actors: { Captain },
  } as Parameters<typeof codingMachine.provide>[0]);
  const actor = createActor(machine, {
    input: { intent: 'demo intent' },
    inspect: (event) => inspector.handle(event),
  });

  const status = document.createElement('pre');
  status.className = 'sketch-controls__status';
  status.textContent = 'Idle.';

  const setStatus = (text: string): void => {
    status.textContent = text;
  };

  let useDisambiguate = false;
  let mount: SketchMount | null = null;

  const remount = (): void => {
    mount?.dispose();
    const source = fromXStateActor({
      actor,
      machine,
      inspector,
      disambiguate: useDisambiguate ? disambiguateByGuard : undefined,
    });
    mount = mountSketch(opts.canvas, { machine, source });
  };

  remount();

  const toggleGroup = createGroup('Disambiguate');
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'sketch-controls__toggle';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.addEventListener('change', () => {
    useDisambiguate = toggleInput.checked;
    setStatus(
      useDisambiguate
        ? 'Disambiguate ON: planAndImplement fires one edge.'
        : 'Disambiguate OFF: planAndImplement fires both edges.',
    );
    remount();
  });
  toggleLabel.appendChild(toggleInput);
  const toggleText = document.createElement('span');
  toggleText.textContent = 'Resolve planAndImplement ambiguity by guard';
  toggleLabel.appendChild(toggleText);
  toggleGroup.appendChild(toggleLabel);

  const bossGroup = createGroup('Boss events', 'sketch-controls__group--buttons');
  for (const { label, event } of BOSS_BUTTONS) {
    bossGroup.appendChild(
      createButton(label, () => {
        actor.send(event);
        setStatus(`Sent ${event.type}.`);
      }),
    );
  }

  const captainGroup = createGroup('Captain output', 'sketch-controls__group--buttons');
  const captainButtons = new Map<string, HTMLButtonElement>();
  for (const guard of ALL_CAPTAIN_GUARDS) {
    const button = createButton(guard, () => {
      if (!pendingCaptain) {
        setStatus('No Captain invocation pending.');
        return;
      }
      const resolve = pendingCaptain;
      pendingCaptain = null;
      resolve({ guard });
      setStatus(`Captain → ${guard}.`);
    });
    captainButtons.set(guard, button);
    captainGroup.appendChild(button);
  }

  const refreshCaptainButtons = (snapshot: { value: unknown }): void => {
    const allowed = pendingCaptain ? allowedGuardsFor(snapshot) : new Set<string>();
    for (const [guard, button] of captainButtons) {
      const enabled = allowed.has(guard);
      button.disabled = !enabled;
      button.title = enabled
        ? `Resolve Captain with guard "${guard}"`
        : pendingCaptain
          ? `Active state has no onDone branch for "${guard}"`
          : 'No Captain invocation pending';
    }
  };

  // pendingCaptain is set inside the Promise creator, which fires synchronously
  // when fromPromise's child actor starts — i.e. between actor.send returning
  // and the next snapshot listener firing. Re-running refresh on each snapshot
  // catches the new invocation. We also refresh after each Captain-resolving
  // click because the resulting microstep may land on another invoke state
  // before the parent snapshot listener observes it.
  const snapshotSub = actor.subscribe((snapshot) => {
    refreshCaptainButtons(snapshot as { value: unknown });
  });

  opts.controls.appendChild(toggleGroup);
  opts.controls.appendChild(bossGroup);
  opts.controls.appendChild(captainGroup);
  opts.controls.appendChild(status);

  actor.start();
  refreshCaptainButtons(actor.getSnapshot() as { value: unknown });

  return {
    dispose() {
      snapshotSub?.unsubscribe?.();
      actor.stop();
      mount?.dispose();
      mount = null;
      pendingCaptain = null;
    },
  };
}
