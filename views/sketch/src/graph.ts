// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AnyStateMachine, StateNode } from 'xstate';

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

type AnyStateNode = StateNode<any, any>;

function nodeId(node: AnyStateNode): string {
  if (node.path.length === 0) {
    return node.machine.id;
  }
  return node.path.join('.');
}

function deriveGuardKey(guard: unknown): string | undefined {
  if (guard == null) return undefined;
  if (typeof guard === 'string') return guard;
  if (typeof guard === 'object') {
    const obj = guard as { type?: unknown };
    if (typeof obj.type === 'string' && obj.type) return obj.type;
  }
  if (typeof guard === 'function') {
    const name = (guard as { name?: string }).name;
    if (name && name !== 'anonymous') return name;
  }
  return undefined;
}

export function extractGraph(machine: AnyStateMachine): SketchGraph {
  const nodes: SketchGraphNode[] = [];
  const edges: SketchGraphEdge[] = [];

  function visit(node: AnyStateNode, parentId: string | undefined): void {
    const id = nodeId(node);
    const initialTarget = node.initial?.target?.[0] as AnyStateNode | undefined;

    const graphNode: SketchGraphNode = {
      id,
      type: node.type,
    };
    if (parentId !== undefined) {
      graphNode.parentId = parentId;
    }
    if (initialTarget) {
      graphNode.initial = initialTarget.key;
    }
    nodes.push(graphNode);

    for (const [eventType, transitions] of node.transitions) {
      for (let branchIndex = 0; branchIndex < transitions.length; branchIndex++) {
        const transition = transitions[branchIndex] as {
          target?: unknown;
          guard?: unknown;
        };
        const targets = (transition.target ?? []) as AnyStateNode[];
        if (targets.length === 0) continue;

        const guardKey = deriveGuardKey(transition.guard);
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
          const toId = nodeId(targets[targetIndex]);
          const kind: SketchGraphEdge['kind'] = id === toId ? 'self' : 'external';

          const edge: SketchGraphEdge = {
            id: `${id}::${eventType}::${branchIndex}::${targetIndex}`,
            from: id,
            to: toId,
            event: eventType,
            kind,
            branchIndex,
            targetIndex,
          };
          if (guardKey !== undefined) {
            edge.guardKey = guardKey;
          }
          edges.push(edge);
        }
      }
    }

    if (node.states) {
      for (const child of Object.values(node.states) as AnyStateNode[]) {
        visit(child, id);
      }
    }
  }

  visit(machine.root as AnyStateNode, undefined);

  return { nodes, edges };
}
