// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AnyActorRef, AnyStateMachine } from 'xstate';

import { extractGraph, type SketchGraph } from './graph';

export interface SketchTelemetryActive {
  type: 'active';
  seq: number;
  activeStateIds: string[];
}

export interface SketchTelemetryFired {
  type: 'fired';
  seq: number;
  firedEdgeIds: string[];
  eventType?: string;
  ttlMs?: number;
}

export type SketchTelemetry = SketchTelemetryActive | SketchTelemetryFired;

export interface SketchSource {
  subscribe(listener: (event: SketchTelemetry) => void): () => void;
  dispose(): void;
}

export type DisambiguateFn = (
  prev: unknown,
  event: unknown,
  next: unknown,
  candidates: string[],
) => string | string[];

export interface XStateActorSourceOptions {
  machine?: AnyStateMachine;
  actor: AnyActorRef;
  inspector?: SketchInspector;
  disambiguate?: DisambiguateFn;
  signal?: AbortSignal;
}

export interface SketchInspector {
  handle(event: unknown): void;
  subscribe(listener: (event: unknown) => void): () => void;
}

export function createSketchInspector(): SketchInspector {
  const listeners = new Set<(event: unknown) => void>();
  return {
    handle(event) {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function leafStateIds(value: unknown): string[] {
  function recurse(v: unknown, prefix: string): string[] {
    if (typeof v === 'string') {
      return [prefix ? `${prefix}.${v}` : v];
    }
    if (typeof v === 'object' && v !== null) {
      const out: string[] = [];
      for (const [key, sub] of Object.entries(v)) {
        const next = prefix ? `${prefix}.${key}` : key;
        out.push(...recurse(sub, next));
      }
      return out;
    }
    return [];
  }
  return recurse(value, '');
}

interface MicrostepTransition {
  eventType?: string;
  target?: { path?: string[]; machine?: { id?: string } }[];
}

interface MicrostepEvent {
  type: string;
  actorRef?: unknown;
  event?: { type?: string };
  snapshot?: unknown;
  _transitions?: MicrostepTransition[];
}

function nodeIdFromPath(
  path: string[] | undefined,
  fallback: string | undefined,
): string {
  if (!path || path.length === 0) return fallback ?? '';
  return path.join('.');
}

function activePathSet(graph: SketchGraph, snapshot: unknown): Set<string> {
  const ids = new Set<string>();
  if (!snapshot || typeof snapshot !== 'object') return ids;
  const value = (snapshot as { value?: unknown }).value;
  const leaves = leafStateIds(value);
  if (leaves.length === 0) return ids;

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const leaf of leaves) {
    let cursor = nodeById.get(leaf);
    while (cursor) {
      ids.add(cursor.id);
      if (cursor.parentId === undefined) break;
      cursor = nodeById.get(cursor.parentId);
    }
  }
  return ids;
}

function nodeDepth(graph: SketchGraph, nodeId: string): number {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  let depth = 0;
  let cursor = nodeById.get(nodeId);
  while (cursor && cursor.parentId !== undefined) {
    depth++;
    cursor = nodeById.get(cursor.parentId);
  }
  return depth;
}

function deriveFiredEdges(
  graph: SketchGraph,
  microstep: MicrostepEvent,
  ctx: { prev: unknown; event: unknown; next: unknown; disambiguate?: DisambiguateFn },
): string[] {
  const transitions = microstep._transitions ?? [];
  const prevActivePath = activePathSet(graph, ctx.prev);
  const candidates = new Set<string>();

  for (const t of transitions) {
    const eventType = t.eventType ?? '';
    const targets = t.target ?? [];

    for (const target of targets) {
      const toId = nodeIdFromPath(target.path, target.machine?.id);

      const matches = graph.edges.filter(
        (e) =>
          e.event === eventType &&
          e.to === toId &&
          prevActivePath.has(e.from),
      );
      if (matches.length === 0) continue;

      const byFrom = new Map<string, typeof matches>();
      for (const m of matches) {
        const list = byFrom.get(m.from);
        if (list) list.push(m);
        else byFrom.set(m.from, [m]);
      }

      let deepestFrom: string | undefined;
      let deepestDepth = -1;
      for (const from of byFrom.keys()) {
        const depth = nodeDepth(graph, from);
        if (depth > deepestDepth) {
          deepestDepth = depth;
          deepestFrom = from;
        }
      }
      if (deepestFrom === undefined) continue;

      for (const m of byFrom.get(deepestFrom) ?? []) {
        candidates.add(m.id);
      }
    }
  }

  const ids = [...candidates];
  if (ctx.disambiguate && ids.length > 0) {
    const result = ctx.disambiguate(ctx.prev, ctx.event, ctx.next, ids);
    return Array.isArray(result) ? result : [result];
  }
  return ids;
}

export function fromXStateActor(
  options: XStateActorSourceOptions,
): SketchSource {
  const { actor, inspector, disambiguate, signal } = options;

  const machine =
    options.machine ?? ((actor as { logic?: AnyStateMachine }).logic);
  if (!machine || !('root' in machine)) {
    throw new Error(
      'fromXStateActor requires a machine option or an actor whose logic exposes root',
    );
  }
  const graph = extractGraph(machine);

  let listener: ((event: SketchTelemetry) => void) | null = null;
  let latestActiveStateIds: string[] | null = null;
  let prevSnapshot: unknown = null;
  let seq = 0;
  let disposed = false;

  function emit(event: SketchTelemetry): void {
    if (disposed) return;
    listener?.(event);
  }

  const actorSub = actor.subscribe((snapshot: { value: unknown }) => {
    if (disposed) return;
    const ids = leafStateIds(snapshot.value);
    latestActiveStateIds = ids;
    prevSnapshot = snapshot;
    seq++;
    emit({ type: 'active', seq, activeStateIds: ids });
  });

  let inspectorUnsub: (() => void) | undefined;
  if (inspector) {
    inspectorUnsub = inspector.subscribe((rawEvent) => {
      if (disposed) return;
      const event = rawEvent as MicrostepEvent;
      if (event.actorRef !== actor) return;
      if (event.type !== '@xstate.microstep') return;

      const firedEdgeIds = deriveFiredEdges(graph, event, {
        prev: prevSnapshot,
        event: event.event,
        next: event.snapshot,
        disambiguate,
      });
      if (firedEdgeIds.length === 0) return;

      seq++;
      const fired: SketchTelemetryFired = {
        type: 'fired',
        seq,
        firedEdgeIds,
      };
      if (typeof event.event?.type === 'string') {
        fired.eventType = event.event.type;
      }
      emit(fired);
    });
  }

  const onAbort = (): void => {
    doDispose();
  };
  signal?.addEventListener('abort', onAbort);

  function doDispose(): void {
    if (disposed) return;
    disposed = true;
    actorSub?.unsubscribe?.();
    inspectorUnsub?.();
    signal?.removeEventListener('abort', onAbort);
    listener = null;
  }

  return {
    subscribe(l) {
      if (disposed) return () => {};
      listener = l;
      if (latestActiveStateIds !== null) {
        seq++;
        l({ type: 'active', seq, activeStateIds: latestActiveStateIds });
      }
      return () => {
        if (listener === l) listener = null;
      };
    },
    dispose: doDispose,
  };
}
