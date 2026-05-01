// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createMachine } from 'xstate';

import { extractGraph } from './graph';
import { renderSketch, renderSketchToString } from './render';

function dataIdSet(root: Element, attr: string): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll(`[${attr}]`).forEach((el) => {
    const value = el.getAttribute(attr);
    if (value !== null) out.add(value);
  });
  return out;
}

const sampleMachine = createMachine({
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
    c: {
      id: 'c',
      type: 'final',
    },
  },
});

describe('renderSketch / renderSketchToString', () => {
  it('produce matching data-state-id and data-edge-id sets', () => {
    const graph = extractGraph(sampleMachine);

    const fromString = new DOMParser()
      .parseFromString(renderSketchToString(graph), 'image/svg+xml')
      .documentElement;
    const fromDom = renderSketch(graph);

    const stateIdsString = dataIdSet(fromString, 'data-state-id');
    const stateIdsDom = dataIdSet(fromDom, 'data-state-id');
    const edgeIdsString = dataIdSet(fromString, 'data-edge-id');
    const edgeIdsDom = dataIdSet(fromDom, 'data-edge-id');

    expect(stateIdsString).toEqual(stateIdsDom);
    expect(edgeIdsString).toEqual(edgeIdsDom);
    expect(stateIdsString.size).toBeGreaterThan(0);
    expect(edgeIdsString.size).toBeGreaterThan(0);
  });

  it('renders compound parents and root as containers and atomic states with expected types', () => {
    const graph = extractGraph(sampleMachine);
    const svg = renderSketch(graph);

    const root = svg.querySelector('[data-state-id="demo"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute('data-state-type')).toBe('compound');
    expect(root?.classList.contains('container')).toBe(true);

    const finalC = svg.querySelector('[data-state-id="c"]');
    expect(finalC?.getAttribute('data-state-type')).toBe('final');

    const atomicA = svg.querySelector('[data-state-id="a"]');
    expect(atomicA?.getAttribute('data-state-type')).toBe('atomic');
  });

  it('renderSketchToString output is valid SVG that parses without parsererror', () => {
    const graph = extractGraph(sampleMachine);
    const str = renderSketchToString(graph);
    expect(typeof str).toBe('string');
    expect(str.startsWith('<svg')).toBe(true);

    const parsed = new DOMParser().parseFromString(str, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
  });

  it('emits an arrowhead marker in defs and references it from every transition', () => {
    const graph = extractGraph(sampleMachine);
    const svg = renderSketch(graph);

    const marker = svg.querySelector('defs marker#sketch-arrow');
    expect(marker).not.toBeNull();

    const transitions = svg.querySelectorAll('.transition');
    expect(transitions.length).toBeGreaterThan(0);
    transitions.forEach((t) => {
      const linePath = t.querySelector('polyline, path');
      expect(linePath, `transition ${t.getAttribute('data-edge-id')} has no polyline/path`).not.toBeNull();
      expect(linePath!.getAttribute('marker-end')).toBe('url(#sketch-arrow)');
    });
  });

  it('renders a final state with a double border (inner final-border rect)', () => {
    const graph = extractGraph(sampleMachine);
    const svg = renderSketch(graph);
    const finalState = svg.querySelector('[data-state-id="c"]');
    expect(finalState).not.toBeNull();
    expect(finalState!.querySelector('rect.final-border')).not.toBeNull();
  });

  it('renders an initial-marker arrow for every state with an initial child', () => {
    const graph = extractGraph(sampleMachine);
    const svg = renderSketch(graph);
    const markers = svg.querySelectorAll('.initial-marker');
    // sampleMachine: demo→a, b→inner
    expect(markers.length).toBe(2);
    const owners = new Set<string>();
    markers.forEach((m) => {
      const owner = m.getAttribute('data-initial-of');
      if (owner) owners.add(owner);
      expect(m.querySelector('line')).not.toBeNull();
    });
    expect(owners).toEqual(new Set(['demo', 'b']));
  });

  it('renders a self-transition as a non-degenerate curved path', () => {
    const selfMachine = createMachine({
      id: 's',
      initial: 'idle',
      states: {
        idle: { id: 'idle', on: { TICK: { target: 'idle' } } },
      },
    });
    const graph = extractGraph(selfMachine);
    const svg = renderSketch(graph);

    const selfEdge = svg.querySelector('[data-edge-id="idle::TICK::0::0"]');
    expect(selfEdge).not.toBeNull();
    expect(selfEdge!.classList.contains('self-loop')).toBe(true);

    const path = selfEdge!.querySelector('path');
    expect(path).not.toBeNull();
    const d = path!.getAttribute('d') ?? '';
    expect(d).toMatch(/^M\s/);
    expect(d).toContain('C');
    expect(path!.getAttribute('marker-end')).toBe('url(#sketch-arrow)');

    expect(selfEdge!.querySelector('line')).toBeNull();
  });
});
