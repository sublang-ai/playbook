// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createMachine, setup } from 'xstate';

import { extractGraph } from './graph';

describe('extractGraph', () => {
  it('produces distinct edge IDs for two guarded branches sharing (from, event, to)', () => {
    const branchAmbiguityMachine = setup({
      guards: {
        alpha: () => true,
        beta: () => false,
      },
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
        done: {
          id: 'done',
          type: 'final',
        },
      },
    });

    const graph = extractGraph(branchAmbiguityMachine);
    const edges = graph.edges.filter((e) => e.from === 'work' && e.to === 'done');

    expect(edges).toHaveLength(2);
    expect(edges[0].id).not.toBe(edges[1].id);
    expect(new Set(edges.map((e) => e.branchIndex))).toEqual(new Set([0, 1]));
    expect(new Set(edges.map((e) => e.targetIndex))).toEqual(new Set([0]));
  });

  it('expands a parent-owned multi-target descriptor into one edge per target', () => {
    const synthMachine = createMachine({
      id: 'parent',
      type: 'parallel',
      on: {
        EVENT: { target: ['#A', '#B'] },
      },
      states: {
        regionOne: {
          initial: 'idle1',
          states: {
            idle1: {},
            A: { id: 'A' },
          },
        },
        regionTwo: {
          initial: 'idle2',
          states: {
            idle2: {},
            B: { id: 'B' },
          },
        },
      },
    });

    const graph = extractGraph(synthMachine);
    const eventEdges = graph.edges.filter((e) => e.event === 'EVENT');

    expect(eventEdges).toHaveLength(2);
    expect(eventEdges.every((e) => e.from === 'parent')).toBe(true);
    expect(eventEdges.every((e) => e.branchIndex === 0)).toBe(true);
    expect(new Set(eventEdges.map((e) => e.targetIndex))).toEqual(new Set([0, 1]));
    expect(new Set(eventEdges.map((e) => e.to))).toEqual(
      new Set(['regionOne.A', 'regionTwo.B']),
    );
    expect(new Set(eventEdges.map((e) => e.id)).size).toBe(2);
  });

  it('uses the machine id for the root and dotted paths with parentId for children', () => {
    const machine = createMachine({
      id: 'tree',
      initial: 'root1',
      states: {
        root1: {
          initial: 'leaf1',
          states: {
            leaf1: {},
          },
        },
      },
    });

    const graph = extractGraph(machine);
    const root = graph.nodes.find((n) => n.id === 'tree');
    expect(root).toBeDefined();
    expect(root?.type).toBe('compound');
    expect(root?.parentId).toBeUndefined();
    expect(root?.initial).toBe('root1');

    const root1 = graph.nodes.find((n) => n.id === 'root1');
    expect(root1?.parentId).toBe('tree');
    expect(root1?.type).toBe('compound');

    const leaf1 = graph.nodes.find((n) => n.id === 'root1.leaf1');
    expect(leaf1?.parentId).toBe('root1');
    expect(leaf1?.type).toBe('atomic');
  });
});
