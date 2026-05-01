// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export type SketchTelemetry =
  | { type: 'active'; seq: number; activeStateIds: string[] }
  | {
      type: 'fired';
      seq: number;
      firedEdgeIds: string[];
      eventType?: string;
      ttlMs?: number;
    };

export interface SketchGraphNode {
  id: string;
  parentId?: string;
  type: 'atomic' | 'compound' | 'parallel' | 'final' | 'history';
  initial?: string;
}

export interface SketchGraphEdge {
  id: string;
  from: string;
  to: string;
  event: string;
  kind: 'external' | 'internal' | 'self';
  branchIndex: number;
  targetIndex: number;
  guardKey?: string;
}

export interface SketchGraph {
  nodes: SketchGraphNode[];
  edges: SketchGraphEdge[];
}

export interface SketchSource {
  subscribe(listener: (event: SketchTelemetry) => void): () => void;
  dispose(): void;
}

export interface SketchMount {
  dispose(): void;
}

export interface SketchMountOptions {
  machine?: unknown;
  graph?: SketchGraph;
  svg?: SVGSVGElement | string;
  source?: SketchSource;
  highlightMs?: number;
}

export interface XStateActorSourceOptions {
  machine?: unknown;
  actor: unknown;
  inspector?: unknown;
  disambiguate?: (
    prev: unknown,
    event: unknown,
    next: unknown,
    candidates: string[],
  ) => string | string[];
  signal?: AbortSignal;
}

export type SketchEventSourceInit = ConstructorParameters<typeof EventSource>[1];

export function mountSketch(
  _container: Element,
  _options: SketchMountOptions,
): SketchMount {
  throw new Error('mountSketch is not implemented yet');
}

export function extractGraph(_machine: unknown): SketchGraph {
  throw new Error('extractGraph is not implemented yet');
}

export function renderSketch(_graph: SketchGraph): SVGSVGElement {
  throw new Error('renderSketch is not implemented yet');
}

export function renderSketchToString(_graph: SketchGraph): string {
  throw new Error('renderSketchToString is not implemented yet');
}

export function applySketchTelemetry(
  _svg: SVGSVGElement,
  _event: SketchTelemetry,
  _opts?: { highlightMs?: number },
): void {
  throw new Error('applySketchTelemetry is not implemented yet');
}

export function fromXStateActor(
  _options: XStateActorSourceOptions,
): SketchSource {
  throw new Error('fromXStateActor is not implemented yet');
}

export function fromEventSource(
  _url: string | URL,
  _init?: SketchEventSourceInit,
): SketchSource {
  throw new Error('fromEventSource is not implemented yet');
}
