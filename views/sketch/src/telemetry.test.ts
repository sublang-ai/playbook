// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import {
  createActor,
  createMachine,
  fromPromise,
  setup,
  type AnyActorRef,
} from 'xstate';

import {
  createSketchInspector,
  fromXStateActor,
  leafStateIds,
  type SketchTelemetry,
} from './telemetry';

function recordingListener(): {
  events: SketchTelemetry[];
  listen: (event: SketchTelemetry) => void;
} {
  const events: SketchTelemetry[] = [];
  return {
    events,
    listen: (event) => {
      events.push(event);
    },
  };
}

describe('leafStateIds', () => {
  it('handles atomic, compound, parallel, and deeply nested values', () => {
    expect(leafStateIds('a')).toEqual(['a']);
    expect(leafStateIds({ b: 'inner' })).toEqual(['b.inner']);
    expect(leafStateIds({ region1: 'a', region2: 'b' })).toEqual([
      'region1.a',
      'region2.b',
    ]);
    expect(leafStateIds({ b: { inner: 'deep' } })).toEqual(['b.inner.deep']);
  });
});

describe('fromXStateActor', () => {
  it('returns a SketchSource shape (subscribe and dispose)', () => {
    const machine = createMachine({ id: 'm', initial: 'a', states: { a: {} } });
    const actor = createActor(machine);
    const source = fromXStateActor({ machine, actor });

    expect(typeof source.subscribe).toBe('function');
    expect(typeof source.dispose).toBe('function');
    source.dispose();
  });

  it('emits an active event for the initial snapshot with leaf state ids', () => {
    const machine = createMachine({
      id: 'm',
      initial: 'a',
      states: { a: {}, b: {} },
    });
    const actor = createActor(machine);
    const source = fromXStateActor({ machine, actor });
    actor.start();

    const { events, listen } = recordingListener();
    source.subscribe(listen);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'active', activeStateIds: ['a'] });
    expect(events[0].seq).toBeGreaterThan(0);

    source.dispose();
  });

  it('replays the latest active to a new subscriber with a fresh seq', () => {
    const machine = createMachine({
      id: 'm',
      initial: 'a',
      states: { a: { on: { GO: 'b' } }, b: {} },
    });
    const actor = createActor(machine);
    const source = fromXStateActor({ machine, actor });
    actor.start();
    actor.send({ type: 'GO' });

    const { events, listen } = recordingListener();
    source.subscribe(listen);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'active', activeStateIds: ['b'] });
    source.dispose();
  });

  it('produces strictly monotone seq across emissions', () => {
    const machine = createMachine({
      id: 'm',
      initial: 'a',
      states: { a: { on: { GO: 'b' } }, b: { on: { BACK: 'a' } } },
    });
    const inspector = createSketchInspector();
    const actor = createActor(machine, { inspect: inspector.handle });
    const source = fromXStateActor({ machine, actor, inspector });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();
    actor.send({ type: 'GO' });
    actor.send({ type: 'BACK' });

    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    source.dispose();
  });

  it('without an inspector emits active events only, no fired', () => {
    const machine = createMachine({
      id: 'm',
      initial: 'a',
      states: { a: { on: { GO: 'b' } }, b: {} },
    });
    const actor = createActor(machine);
    const source = fromXStateActor({ machine, actor });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();
    actor.send({ type: 'GO' });

    const fired = events.filter((e) => e.type === 'fired');
    const active = events.filter((e) => e.type === 'active');
    expect(fired).toHaveLength(0);
    expect(active.length).toBeGreaterThanOrEqual(2);
    source.dispose();
  });

  it('emits fired events with both candidate edges for a guarded branch ambiguity (no disambiguate)', () => {
    const machine = setup({
      guards: { alpha: () => true, beta: () => true },
    }).createMachine({
      id: 'demo',
      initial: 'work',
      states: {
        work: {
          id: 'work',
          on: {
            TICK: [
              { guard: 'alpha', target: '#done' },
              { guard: 'beta', target: '#done' },
            ],
          },
        },
        done: { id: 'done', type: 'final' },
      },
    });
    const inspector = createSketchInspector();
    const actor = createActor(machine, { inspect: inspector.handle });
    const source = fromXStateActor({ machine, actor, inspector });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();
    actor.send({ type: 'TICK' });

    const fired = events.find((e) => e.type === 'fired');
    if (!fired || fired.type !== 'fired') {
      throw new Error('expected a fired event');
    }
    expect(new Set(fired.firedEdgeIds)).toEqual(
      new Set(['work::TICK::0::0', 'work::TICK::1::0']),
    );
    source.dispose();
  });

  it('narrows ambiguous fired candidates via disambiguate', () => {
    const machine = setup({
      guards: { alpha: () => true, beta: () => true },
    }).createMachine({
      id: 'demo',
      initial: 'work',
      states: {
        work: {
          id: 'work',
          on: {
            TICK: [
              { guard: 'alpha', target: '#done' },
              { guard: 'beta', target: '#done' },
            ],
          },
        },
        done: { id: 'done', type: 'final' },
      },
    });
    const inspector = createSketchInspector();
    const actor = createActor(machine, { inspect: inspector.handle });
    const source = fromXStateActor({
      machine,
      actor,
      inspector,
      disambiguate: (_p, _e, _n, candidates) => candidates[0],
    });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();
    actor.send({ type: 'TICK' });

    const fired = events.find((e) => e.type === 'fired');
    expect(fired).toBeDefined();
    if (fired?.type !== 'fired') return;
    expect(fired.firedEdgeIds).toEqual(['work::TICK::0::0']);
    source.dispose();
  });

  it('emits only the deepest matching owner when parent and root share a descriptor; emits the root when the parent descriptor is removed', () => {
    function build(parentHasEvent: boolean) {
      return createMachine({
        id: 'demo',
        initial: 'parent',
        on: { EVENT: '#target' },
        states: {
          parent: {
            id: 'parent',
            initial: 'leaf',
            ...(parentHasEvent ? { on: { EVENT: '#target' } } : {}),
            states: { leaf: {} },
          },
          target: { id: 'target' },
        },
      });
    }

    function fireOnce(machineFactory: ReturnType<typeof build>): SketchTelemetry[] {
      const inspector = createSketchInspector();
      const actor = createActor(machineFactory, { inspect: inspector.handle });
      const source = fromXStateActor({ machine: machineFactory, actor, inspector });
      const { events, listen } = recordingListener();
      source.subscribe(listen);
      actor.start();
      actor.send({ type: 'EVENT' });
      source.dispose();
      return events;
    }

    const withParent = fireOnce(build(true));
    const withoutParent = fireOnce(build(false));

    const firedWith = withParent.find((e) => e.type === 'fired');
    expect(firedWith).toBeDefined();
    if (firedWith?.type !== 'fired') return;
    expect(firedWith.firedEdgeIds).toEqual(['parent::EVENT::0::0']);

    const firedWithout = withoutParent.find((e) => e.type === 'fired');
    expect(firedWithout).toBeDefined();
    if (firedWithout?.type !== 'fired') return;
    expect(firedWithout.firedEdgeIds).toEqual(['demo::EVENT::0::0']);
  });

  it('expands a parallel-root multi-target descriptor into a single fired event with both edge ids', () => {
    const machine = createMachine({
      id: 'parent',
      type: 'parallel',
      on: { EVENT: { target: ['#A', '#B'] } },
      states: {
        one: { initial: 'idle1', states: { idle1: {}, A: { id: 'A' } } },
        two: { initial: 'idle2', states: { idle2: {}, B: { id: 'B' } } },
      },
    });
    const inspector = createSketchInspector();
    const actor = createActor(machine, { inspect: inspector.handle });
    const source = fromXStateActor({ machine, actor, inspector });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();
    actor.send({ type: 'EVENT' });

    const fired = events.filter((e) => e.type === 'fired');
    expect(fired).toHaveLength(1);
    if (fired[0].type !== 'fired') return;
    expect(new Set(fired[0].firedEdgeIds)).toEqual(
      new Set(['parent::EVENT::0::0', 'parent::EVENT::0::1']),
    );
    source.dispose();
  });

  it('drops inspect events for invoked child actors (actorRef filter, not rootId)', () => {
    const child = fromPromise(async () => 'ok');
    const machine = createMachine({
      id: 'parent',
      initial: 'work',
      states: {
        work: { invoke: { src: child, onDone: 'done' } },
        done: { type: 'final' },
      },
    });

    const captured: unknown[] = [];
    const tap = createSketchInspector();
    const actor = createActor(machine, {
      inspect: (event) => {
        captured.push(event);
        tap.handle(event);
      },
    });
    const source = fromXStateActor({ machine, actor, inspector: tap });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const matchingActorRef = captured.filter(
          (e) => (e as { actorRef?: AnyActorRef }).actorRef === actor,
        ).length;
        const matchingRootId = captured.filter(
          (e) =>
            (e as { rootId?: string }).rootId === (actor as AnyActorRef).sessionId,
        ).length;
        expect(matchingRootId).toBeGreaterThan(matchingActorRef);

        const fired = events.filter((e) => e.type === 'fired');
        for (const f of fired) {
          if (f.type !== 'fired') continue;
          for (const id of f.firedEdgeIds) {
            expect(id.startsWith('parent') || id.startsWith('work')).toBe(true);
          }
        }

        source.dispose();
        resolve();
      }, 20);
    });
  });

  it('emits a fired event for every microstep in a chained macrostep (always after a guarded transition)', () => {
    const machine = createMachine({
      id: 'demo',
      initial: 'a',
      states: {
        a: { id: 'a', on: { GO: 'b' } },
        b: { id: 'b', always: { target: 'c' } },
        c: { id: 'c', type: 'final' },
      },
    });
    const inspector = createSketchInspector();
    const actor = createActor(machine, { inspect: inspector.handle });
    const source = fromXStateActor({ machine, actor, inspector });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();
    actor.send({ type: 'GO' });

    const fired = events.filter((e) => e.type === 'fired');
    expect(fired).toHaveLength(2);
    if (fired[0].type !== 'fired' || fired[1].type !== 'fired') {
      throw new Error('expected fired events');
    }
    expect(fired[0].firedEdgeIds).toEqual(['a::GO::0::0']);
    expect(fired[1].firedEdgeIds).toEqual(['b::::0::0']);
    expect(fired[1].seq).toBeGreaterThan(fired[0].seq);
    source.dispose();
  });

  it('dispose stops further callbacks and is idempotent', () => {
    const machine = createMachine({
      id: 'm',
      initial: 'a',
      states: { a: { on: { GO: 'b' } }, b: {} },
    });
    const actor = createActor(machine);
    const source = fromXStateActor({ machine, actor });

    const { events, listen } = recordingListener();
    source.subscribe(listen);
    actor.start();

    const beforeDispose = events.length;
    source.dispose();
    actor.send({ type: 'GO' });
    expect(events.length).toBe(beforeDispose);

    source.dispose();
  });
});
