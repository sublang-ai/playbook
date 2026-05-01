// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AnyStateMachine } from 'xstate';

import { extractGraph } from './graph';
import type { SketchGraph } from './graph';
import { renderSketch } from './render';
import type { SketchSource, SketchTelemetry } from './telemetry';

const DEFAULT_HIGHLIGHT_MS = 600;

function attrEsc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface ApplyTelemetryOptions {
  highlightMs?: number;
  onComplete?: () => void;
}

export function applySketchTelemetry(
  svg: SVGSVGElement,
  event: SketchTelemetry,
  opts?: ApplyTelemetryOptions,
): () => void {
  if (event.type === 'active') {
    svg.querySelectorAll('.state.active').forEach((el) => {
      el.classList.remove('active');
    });
    for (const id of event.activeStateIds) {
      svg.querySelector(`[data-state-id="${attrEsc(id)}"]`)?.classList.add('active');
    }
    return () => {};
  }

  const ttl = event.ttlMs ?? opts?.highlightMs ?? DEFAULT_HIGHLIGHT_MS;
  const els: Element[] = [];
  for (const id of event.firedEdgeIds) {
    const el = svg.querySelector(`[data-edge-id="${attrEsc(id)}"]`);
    if (el) {
      el.classList.add('fired');
      els.push(el);
    }
  }

  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    for (const el of els) el.classList.remove('fired');
    opts?.onComplete?.();
  };
  const timer = setTimeout(finish, ttl);
  return () => {
    clearTimeout(timer);
    finish();
  };
}

export type SketchEventSourceInit = ConstructorParameters<typeof EventSource>[1];

export function fromEventSource(
  url: string | URL,
  init?: SketchEventSourceInit,
): SketchSource {
  let listener: ((event: SketchTelemetry) => void) | null = null;
  let highestSeq = -Infinity;
  let disposed = false;

  const eventSource = new EventSource(url, init);

  const onTelemetry = (msg: Event): void => {
    if (disposed) return;
    const data = (msg as MessageEvent).data;
    if (typeof data !== 'string') return;
    let parsed: SketchTelemetry;
    try {
      parsed = JSON.parse(data) as SketchTelemetry;
    } catch {
      return;
    }
    if (typeof parsed.seq !== 'number') return;
    if (parsed.seq <= highestSeq) return;
    highestSeq = parsed.seq;
    listener?.(parsed);
  };

  const onOpen = (): void => {
    highestSeq = -Infinity;
  };

  eventSource.addEventListener('telemetry', onTelemetry);
  eventSource.addEventListener('open', onOpen);

  return {
    subscribe(l) {
      if (disposed) return () => {};
      listener = l;
      return () => {
        if (listener === l) listener = null;
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      eventSource.removeEventListener('telemetry', onTelemetry);
      eventSource.removeEventListener('open', onOpen);
      eventSource.close();
      listener = null;
    },
  };
}

export interface SketchMount {
  dispose(): void;
}

export interface SketchMountOptions {
  machine?: AnyStateMachine;
  graph?: SketchGraph;
  svg?: SVGSVGElement | string;
  source?: SketchSource;
  highlightMs?: number;
}

function resolveSvg(options: SketchMountOptions): SVGSVGElement {
  if (options.svg) {
    if (typeof options.svg === 'string') {
      const parsed = new DOMParser().parseFromString(options.svg, 'image/svg+xml');
      return parsed.documentElement as unknown as SVGSVGElement;
    }
    return options.svg;
  }
  if (options.graph) {
    return renderSketch(options.graph);
  }
  if (options.machine) {
    return renderSketch(extractGraph(options.machine));
  }
  throw new Error('mountSketch requires one of: machine, graph, svg');
}

export function mountSketch(
  container: Element,
  options: SketchMountOptions,
): SketchMount {
  const svg = resolveSvg(options);
  container.appendChild(svg);

  const pendingCancels = new Set<() => void>();
  let sourceUnsubscribe: (() => void) | undefined;
  let disposed = false;

  if (options.source) {
    sourceUnsubscribe = options.source.subscribe((event) => {
      if (disposed) return;
      let cancel: (() => void) | undefined;
      cancel = applySketchTelemetry(svg, event, {
        highlightMs: options.highlightMs,
        onComplete: () => {
          if (cancel) pendingCancels.delete(cancel);
        },
      });
      if (event.type === 'fired') {
        pendingCancels.add(cancel);
      }
    });
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;

      sourceUnsubscribe?.();
      options.source?.dispose();

      for (const cancel of [...pendingCancels]) cancel();
      pendingCancels.clear();

      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }
    },
  };
}
