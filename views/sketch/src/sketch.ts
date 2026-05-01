// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AnyStateMachine } from 'xstate';

import { extractGraph } from './graph';
import type { SketchGraph } from './graph';
import { renderSketch, renderSketchToString } from './render';
import { createSketchInspector, fromXStateActor } from './telemetry';
import type { SketchSource, SketchTelemetry } from './telemetry';

export type {
  SketchGraph,
  SketchGraphEdge,
  SketchGraphNode,
} from './graph';
export type { EdgeRoute, NodePlacement, SketchLayout } from './layout';
export type {
  DisambiguateFn,
  SketchInspector,
  SketchSource,
  SketchTelemetry,
  SketchTelemetryActive,
  SketchTelemetryFired,
  XStateActorSourceOptions,
} from './telemetry';
export { elkLayout, placeholderLayout } from './layout';
export { extractGraph };
export { renderSketch, renderSketchToString };
export { createSketchInspector, fromXStateActor };

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

export type SketchEventSourceInit = ConstructorParameters<typeof EventSource>[1];

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

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (svg.parentNode === container) {
        container.removeChild(svg);
      }
    },
  };
}

export function applySketchTelemetry(
  _svg: SVGSVGElement,
  _event: SketchTelemetry,
  _opts?: { highlightMs?: number },
): void {
  throw new Error('applySketchTelemetry is not implemented yet');
}

export function fromEventSource(
  _url: string | URL,
  _init?: SketchEventSourceInit,
): SketchSource {
  throw new Error('fromEventSource is not implemented yet');
}
