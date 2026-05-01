// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';

import { extractGraph } from './graph';
import { elkLayout, placeholderLayout } from './layout';

const sample = createMachine({
  id: 'demo',
  initial: 'a',
  states: {
    a: {
      id: 'a',
      on: { GO: 'b' },
    },
    b: {
      id: 'b',
      initial: 'inner',
      states: {
        inner: {
          on: { BACK: '#a' },
        },
      },
    },
  },
});

describe('placeholderLayout', () => {
  it('places every node with positive dimensions', () => {
    const graph = extractGraph(sample);
    const layout = placeholderLayout(graph);

    for (const node of graph.nodes) {
      const placement = layout.nodes.get(node.id);
      expect(placement, `missing placement for ${node.id}`).toBeDefined();
      expect(placement!.width).toBeGreaterThan(0);
      expect(placement!.height).toBeGreaterThan(0);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('makes a compound parent encompass its children', () => {
    const graph = extractGraph(sample);
    const layout = placeholderLayout(graph);
    const parent = layout.nodes.get('b')!;
    const child = layout.nodes.get('b.inner')!;

    expect(child.x).toBeGreaterThanOrEqual(parent.x);
    expect(child.y).toBeGreaterThanOrEqual(parent.y);
    expect(child.x + child.width).toBeLessThanOrEqual(parent.x + parent.width);
    expect(child.y + child.height).toBeLessThanOrEqual(parent.y + parent.height);
  });
});

describe('elkLayout', () => {
  it('places every node and routes every edge via the elkjs layered algorithm', async () => {
    const graph = extractGraph(sample);
    const layout = await elkLayout(graph);

    for (const node of graph.nodes) {
      const placement = layout.nodes.get(node.id);
      expect(placement, `elk missing placement for ${node.id}`).toBeDefined();
      expect(placement!.width).toBeGreaterThan(0);
      expect(placement!.height).toBeGreaterThan(0);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);

    expect(layout.edges).toBeDefined();
    for (const edge of graph.edges) {
      const route = layout.edges!.get(edge.id);
      expect(route, `elk missing route for ${edge.id}`).toBeDefined();
      expect(route!.points.length).toBeGreaterThanOrEqual(2);
    }
  });
});
