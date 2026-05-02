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

interface CaptainButton {
  label: string;
  output: CaptainOutput;
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

const CAPTAIN_BUTTONS: CaptainButton[] = [
  { label: 'singleCommitCommitted', output: { guard: 'singleCommitCommitted' } },
  { label: 'iterationCommitted', output: { guard: 'iterationCommitted' } },
  { label: 'taskCommitted', output: { guard: 'taskCommitted' } },
  { label: 'changesReadyForReview', output: { guard: 'changesReadyForReview' } },
  { label: 'iterationDone', output: { guard: 'iterationDone' } },
  { label: 'noFindings', output: { guard: 'noFindings' } },
  { label: 'hasFindings', output: { guard: 'hasFindings' } },
  { label: 'changesMade', output: { guard: 'changesMade' } },
  { label: 'challengesRaised', output: { guard: 'challengesRaised' } },
  { label: 'readyToCommit', output: { guard: 'readyToCommit' } },
  { label: 'challengeAccepted', output: { guard: 'challengeAccepted' } },
  { label: 'challengeRejected', output: { guard: 'challengeRejected' } },
  { label: 'changesNeedReview', output: { guard: 'changesNeedReview' } },
  { label: 'noOpenItems', output: { guard: 'noOpenItems' } },
  { label: 'committed', output: { guard: 'committed' } },
  { label: 'noRelevantChanges', output: { guard: 'noRelevantChanges' } },
  { label: 'ciPassed', output: { guard: 'ciPassed' } },
  { label: 'ciFailed', output: { guard: 'ciFailed' } },
  { label: 'flakyRerunStarted', output: { guard: 'flakyRerunStarted' } },
  { label: 'pushedNoCi', output: { guard: 'pushedNoCi' } },
  { label: 'fixNeeded', output: { guard: 'fixNeeded' } },
  { label: 'flaky', output: { guard: 'flaky' } },
  { label: 'noAction', output: { guard: 'noAction' } },
  { label: 'fixCommittedNoPush', output: { guard: 'fixCommittedNoPush' } },
  { label: 'specsReadyForReview', output: { guard: 'specsReadyForReview' } },
  { label: 'noSpecChangesNeeded', output: { guard: 'noSpecChangesNeeded' } },
  { label: 'needsBossInput', output: { guard: 'needsBossInput' } },
];

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
  for (const { label, output } of CAPTAIN_BUTTONS) {
    captainGroup.appendChild(
      createButton(label, () => {
        if (!pendingCaptain) {
          setStatus('No Captain invocation pending.');
          return;
        }
        const resolve = pendingCaptain;
        pendingCaptain = null;
        resolve(output);
        setStatus(`Captain → ${label}.`);
      }),
    );
  }

  opts.controls.appendChild(toggleGroup);
  opts.controls.appendChild(bossGroup);
  opts.controls.appendChild(captainGroup);
  opts.controls.appendChild(status);

  actor.start();

  return {
    dispose() {
      actor.stop();
      mount?.dispose();
      mount = null;
      pendingCaptain = null;
    },
  };
}
