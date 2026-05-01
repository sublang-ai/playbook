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
});
