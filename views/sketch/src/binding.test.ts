// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachine } from 'xstate';

import {
  applySketchTelemetry,
  fromEventSource,
  mountSketch,
} from './binding';
import { extractGraph } from './graph';
import { renderSketch } from './render';
import type { SketchSource, SketchTelemetry } from './telemetry';

const sampleMachine = createMachine({
  id: 'demo',
  initial: 'a',
  states: {
    a: { id: 'a', on: { GO: 'b' } },
    b: { id: 'b', on: { BACK: 'a' } },
  },
});

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  url: string;
  init: EventSourceInit | undefined;
  closed = false;

  constructor(url: string | URL, init?: EventSourceInit) {
    super();
    this.url = String(url);
    this.init = init;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(eventName: string, data: string): void {
    this.dispatchEvent(new MessageEvent(eventName, { data }));
  }

  signalOpen(): void {
    this.dispatchEvent(new Event('open'));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  FakeEventSource.instances = [];
});

describe('applySketchTelemetry', () => {
  it('toggles .active on matching state and clears prior actives', () => {
    const svg = renderSketch(extractGraph(sampleMachine));

    applySketchTelemetry(svg, { type: 'active', seq: 1, activeStateIds: ['a'] });
    expect(svg.querySelector('[data-state-id="a"]')?.classList.contains('active')).toBe(true);

    applySketchTelemetry(svg, { type: 'active', seq: 2, activeStateIds: ['b'] });
    expect(svg.querySelector('[data-state-id="a"]')?.classList.contains('active')).toBe(false);
    expect(svg.querySelector('[data-state-id="b"]')?.classList.contains('active')).toBe(true);
  });

  it('toggles .fired on matching edges and clears them after the ttl elapses', async () => {
    vi.useFakeTimers();
    try {
      const svg = renderSketch(extractGraph(sampleMachine));
      applySketchTelemetry(
        svg,
        { type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0'] },
        { highlightMs: 100 },
      );
      const edge = svg.querySelector('[data-edge-id="a::GO::0::0"]');
      expect(edge?.classList.contains('fired')).toBe(true);

      vi.advanceTimersByTime(99);
      expect(edge?.classList.contains('fired')).toBe(true);
      vi.advanceTimersByTime(2);
      expect(edge?.classList.contains('fired')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors per-event ttlMs over opts.highlightMs', () => {
    vi.useFakeTimers();
    try {
      const svg = renderSketch(extractGraph(sampleMachine));
      applySketchTelemetry(
        svg,
        { type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0'], ttlMs: 50 },
        { highlightMs: 5000 },
      );
      const edge = svg.querySelector('[data-edge-id="a::GO::0::0"]');
      expect(edge?.classList.contains('fired')).toBe(true);
      vi.advanceTimersByTime(60);
      expect(edge?.classList.contains('fired')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('superseding one edge of a multi-edge fired event leaves the other edge highlighted for its full ttl', () => {
    vi.useFakeTimers();
    try {
      const svg = renderSketch(extractGraph(sampleMachine));

      applySketchTelemetry(
        svg,
        { type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0', 'b::BACK::0::0'] },
        { highlightMs: 100 },
      );
      const edgeA = svg.querySelector('[data-edge-id="a::GO::0::0"]');
      const edgeB = svg.querySelector('[data-edge-id="b::BACK::0::0"]');
      expect(edgeA?.classList.contains('fired')).toBe(true);
      expect(edgeB?.classList.contains('fired')).toBe(true);

      vi.advanceTimersByTime(50);
      applySketchTelemetry(
        svg,
        { type: 'fired', seq: 2, firedEdgeIds: ['a::GO::0::0'] },
        { highlightMs: 100 },
      );
      expect(edgeA?.classList.contains('fired')).toBe(true);
      // Critical: B's own timer must still be pending; the prior bug would clear it.
      expect(edgeB?.classList.contains('fired')).toBe(true);

      // Past B's original t=100 deadline; B clears, A's fresh t=150 still pending.
      vi.advanceTimersByTime(60);
      expect(edgeB?.classList.contains('fired')).toBe(false);
      expect(edgeA?.classList.contains('fired')).toBe(true);

      // Past A's t=150 deadline; A finally clears.
      vi.advanceTimersByTime(60);
      expect(edgeA?.classList.contains('fired')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('overlapping fired events on the same edge keep the highlight active for the latest TTL', () => {
    vi.useFakeTimers();
    try {
      const svg = renderSketch(extractGraph(sampleMachine));

      applySketchTelemetry(
        svg,
        { type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0'] },
        { highlightMs: 100 },
      );
      const edge = svg.querySelector('[data-edge-id="a::GO::0::0"]');
      expect(edge?.classList.contains('fired')).toBe(true);

      vi.advanceTimersByTime(50);
      expect(edge?.classList.contains('fired')).toBe(true);

      applySketchTelemetry(
        svg,
        { type: 'fired', seq: 2, firedEdgeIds: ['a::GO::0::0'] },
        { highlightMs: 100 },
      );
      expect(edge?.classList.contains('fired')).toBe(true);

      // Past the first call's original TTL but still inside the second's.
      vi.advanceTimersByTime(60);
      expect(edge?.classList.contains('fired')).toBe(true);

      // Past the second call's TTL; the highlight finally clears.
      vi.advanceTimersByTime(60);
      expect(edge?.classList.contains('fired')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires onComplete synchronously when firedEdgeIds is empty', () => {
    const svg = renderSketch(extractGraph(sampleMachine));
    let completed = false;
    applySketchTelemetry(
      svg,
      { type: 'fired', seq: 1, firedEdgeIds: [] },
      {
        onComplete: () => {
          completed = true;
        },
      },
    );
    expect(completed).toBe(true);
  });

  it('fires onComplete synchronously when every fired id misses the SVG', () => {
    const svg = renderSketch(extractGraph(sampleMachine));
    let completed = false;
    applySketchTelemetry(
      svg,
      { type: 'fired', seq: 1, firedEdgeIds: ['nonexistent::edge::0::0'] },
      {
        onComplete: () => {
          completed = true;
        },
      },
    );
    expect(completed).toBe(true);
  });

  it('cancel handle clears the .fired class immediately and cancels the timer', () => {
    vi.useFakeTimers();
    try {
      const svg = renderSketch(extractGraph(sampleMachine));
      const cancel = applySketchTelemetry(
        svg,
        { type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0'] },
        { highlightMs: 1000 },
      );
      const edge = svg.querySelector('[data-edge-id="a::GO::0::0"]');
      expect(edge?.classList.contains('fired')).toBe(true);
      cancel();
      expect(edge?.classList.contains('fired')).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(edge?.classList.contains('fired')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fromEventSource', () => {
  it('returns a SketchSource shape (subscribe + dispose)', () => {
    const source = fromEventSource('http://example.test/events');
    expect(typeof source.subscribe).toBe('function');
    expect(typeof source.dispose).toBe('function');
    source.dispose();
  });

  it('forwards event:telemetry SSE records as SketchTelemetry', () => {
    const source = fromEventSource('http://example.test/events');
    const events: SketchTelemetry[] = [];
    source.subscribe((e) => events.push(e));

    const es = FakeEventSource.instances[0];
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 1, activeStateIds: ['a'] }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'active', seq: 1, activeStateIds: ['a'] });

    source.dispose();
  });

  it('drops events with seq not strictly greater than the highest seen', () => {
    const source = fromEventSource('http://example.test/events');
    const events: SketchTelemetry[] = [];
    source.subscribe((e) => events.push(e));

    const es = FakeEventSource.instances[0];
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 5, activeStateIds: ['a'] }));
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 3, activeStateIds: ['x'] }));
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 5, activeStateIds: ['y'] }));
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 6, activeStateIds: ['z'] }));

    expect(events.map((e) => e.seq)).toEqual([5, 6]);
    source.dispose();
  });

  it('resets seq tracking on reconnect (open after a gap)', () => {
    const source = fromEventSource('http://example.test/events');
    const events: SketchTelemetry[] = [];
    source.subscribe((e) => events.push(e));

    const es = FakeEventSource.instances[0];
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 100, activeStateIds: ['a'] }));
    es.signalOpen();
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 1, activeStateIds: ['b'] }));

    expect(events.map((e) => e.seq)).toEqual([100, 1]);
    source.dispose();
  });

  it('dispose closes the EventSource and stops further forwarding', () => {
    const source = fromEventSource('http://example.test/events');
    const events: SketchTelemetry[] = [];
    source.subscribe((e) => events.push(e));

    const es = FakeEventSource.instances[0];
    source.dispose();
    expect(es.closed).toBe(true);

    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 1, activeStateIds: ['a'] }));
    expect(events).toHaveLength(0);
  });

  it('ignores malformed JSON or records without numeric seq', () => {
    const source = fromEventSource('http://example.test/events');
    const events: SketchTelemetry[] = [];
    source.subscribe((e) => events.push(e));

    const es = FakeEventSource.instances[0];
    es.emit('telemetry', 'not-json');
    es.emit('telemetry', JSON.stringify({ type: 'active', activeStateIds: ['a'] }));
    es.emit('telemetry', JSON.stringify({ type: 'active', seq: 1, activeStateIds: ['a'] }));

    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
    source.dispose();
  });
});

describe('mountSketch with a source', () => {
  function makePushSource(): {
    source: SketchSource;
    push: (event: SketchTelemetry) => void;
    disposeSpy: ReturnType<typeof vi.fn>;
  } {
    let listener: ((e: SketchTelemetry) => void) | null = null;
    const disposeSpy = vi.fn();
    const source: SketchSource = {
      subscribe(l) {
        listener = l;
        return () => {
          if (listener === l) listener = null;
        };
      },
      dispose() {
        disposeSpy();
      },
    };
    return {
      source,
      push: (e) => listener?.(e),
      disposeSpy,
    };
  }

  it('subscribes to the source and applies telemetry to the mounted SVG', () => {
    const container = document.createElement('div');
    const { source, push } = makePushSource();
    const mount = mountSketch(container, { machine: sampleMachine, source });

    push({ type: 'active', seq: 1, activeStateIds: ['a'] });
    const svg = container.querySelector('svg');
    expect(svg?.querySelector('[data-state-id="a"]')?.classList.contains('active')).toBe(true);

    mount.dispose();
  });

  it('runs the three-step teardown on dispose: source, timers, container', () => {
    vi.useFakeTimers();
    try {
      const container = document.createElement('div');
      const { source, push, disposeSpy } = makePushSource();
      const mount = mountSketch(container, {
        machine: sampleMachine,
        source,
        highlightMs: 1000,
      });

      push({ type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0'] });
      const svg = container.querySelector('svg')!;
      expect(svg.querySelector('[data-edge-id="a::GO::0::0"]')?.classList.contains('fired')).toBe(true);

      mount.dispose();

      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(svg.querySelector('[data-edge-id="a::GO::0::0"]')?.classList.contains('fired')).toBe(false);
      expect(container.firstChild).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('double dispose is a no-op', () => {
    const container = document.createElement('div');
    const { source, disposeSpy } = makePushSource();
    const mount = mountSketch(container, { machine: sampleMachine, source });

    mount.dispose();
    mount.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('drops telemetry that arrives after dispose', () => {
    vi.useFakeTimers();
    try {
      const container = document.createElement('div');
      const { source, push } = makePushSource();
      const mount = mountSketch(container, { machine: sampleMachine, source });
      const svg = container.querySelector('svg')!;

      mount.dispose();
      push({ type: 'fired', seq: 1, firedEdgeIds: ['a::GO::0::0'] });
      // svg is detached now; the fired class shouldn't have been re-added inside it
      expect(svg.querySelector('[data-edge-id="a::GO::0::0"]')?.classList.contains('fired')).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });
});
