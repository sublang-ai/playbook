// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import ELK from 'elkjs/lib/elk.bundled.js';

import type { SketchGraph, SketchGraphNode } from './graph';

export interface NodePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EdgeRoute {
  points: { x: number; y: number }[];
}

export interface SketchLayout {
  nodes: Map<string, NodePlacement>;
  edges?: Map<string, EdgeRoute>;
  width: number;
  height: number;
}

const ATOMIC_W = 120;
const ATOMIC_H = 40;
const HEADER_H = 24;
const PAD = 12;
const GAP = 8;

export function placeholderLayout(graph: SketchGraph): SketchLayout {
  const childrenByParent = new Map<string | undefined, SketchGraphNode[]>();
  for (const node of graph.nodes) {
    const list = childrenByParent.get(node.parentId);
    if (list) {
      list.push(node);
    } else {
      childrenByParent.set(node.parentId, [node]);
    }
  }

  const placements = new Map<string, NodePlacement>();

  function place(nodeId: string, x: number, y: number): { width: number; height: number } {
    const children = childrenByParent.get(nodeId) ?? [];

    if (children.length === 0) {
      placements.set(nodeId, { x, y, width: ATOMIC_W, height: ATOMIC_H });
      return { width: ATOMIC_W, height: ATOMIC_H };
    }

    let cursorY = y + HEADER_H + PAD;
    let maxChildWidth = 0;

    for (const child of children) {
      const dim = place(child.id, x + PAD, cursorY);
      cursorY += dim.height + GAP;
      maxChildWidth = Math.max(maxChildWidth, dim.width);
    }
    cursorY -= GAP;

    const width = maxChildWidth + 2 * PAD;
    const height = cursorY - y + PAD;
    placements.set(nodeId, { x, y, width, height });
    return { width, height };
  }

  const roots = childrenByParent.get(undefined) ?? [];
  let totalWidth = 0;
  let totalHeight = 0;
  let cursorY = 0;

  for (const root of roots) {
    const dim = place(root.id, 0, cursorY);
    cursorY += dim.height + GAP;
    totalWidth = Math.max(totalWidth, dim.width);
    totalHeight = cursorY - GAP;
  }

  return {
    nodes: placements,
    width: Math.max(totalWidth, 1),
    height: Math.max(totalHeight, 1),
  };
}

interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  children?: ElkNode[];
  layoutOptions?: Record<string, string>;
  x?: number;
  y?: number;
}

interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  sections?: {
    startPoint: { x: number; y: number };
    endPoint: { x: number; y: number };
    bendPoints?: { x: number; y: number }[];
  }[];
}

type ElkContainer = ElkNode & { edges?: ElkEdge[] };

export async function elkLayout(graph: SketchGraph): Promise<SketchLayout> {
  const elk = new ELK();

  const nodeById = new Map<string, SketchGraphNode>();
  for (const n of graph.nodes) nodeById.set(n.id, n);

  const childrenByParent = new Map<string | undefined, SketchGraphNode[]>();
  for (const n of graph.nodes) {
    const list = childrenByParent.get(n.parentId);
    if (list) list.push(n);
    else childrenByParent.set(n.parentId, [n]);
  }

  const elkNodeById = new Map<string, ElkContainer>();

  function build(node: SketchGraphNode): ElkContainer {
    const kids = childrenByParent.get(node.id) ?? [];
    const elkNode: ElkContainer = { id: node.id };
    if (kids.length === 0) {
      elkNode.width = ATOMIC_W;
      elkNode.height = ATOMIC_H;
    } else {
      elkNode.children = kids.map(build);
      elkNode.layoutOptions = {
        'elk.algorithm': 'layered',
        'elk.padding': `[top=${HEADER_H},left=${PAD},right=${PAD},bottom=${PAD}]`,
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      };
    }
    elkNodeById.set(node.id, elkNode);
    return elkNode;
  }

  const roots = (childrenByParent.get(undefined) ?? []).map(build);
  const elkRoot: ElkContainer = {
    id: '__root__',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    },
    children: roots,
    edges: [],
  };

  function pathToRoot(id: string): string[] {
    const path: string[] = [];
    let cursor = nodeById.get(id);
    while (cursor) {
      path.push(cursor.id);
      if (cursor.parentId === undefined) break;
      cursor = nodeById.get(cursor.parentId);
    }
    return path;
  }

  function deepestCommonAncestor(a: string, b: string): string | undefined {
    const setB = new Set(pathToRoot(b));
    for (const ancestor of pathToRoot(a)) {
      if (setB.has(ancestor)) return ancestor;
    }
    return undefined;
  }

  for (const edge of graph.edges) {
    let containerId: string | undefined;
    if (edge.from === edge.to) {
      containerId = nodeById.get(edge.from)?.parentId;
    } else {
      containerId = deepestCommonAncestor(edge.from, edge.to);
    }
    const container = (containerId && elkNodeById.get(containerId)) || elkRoot;
    if (!container.edges) container.edges = [];
    container.edges.push({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
    });
  }

  const result = (await elk.layout(
    elkRoot as unknown as Parameters<typeof elk.layout>[0],
  )) as unknown as ElkNode & {
    edges?: ElkEdge[];
    width?: number;
    height?: number;
  };

  const placements = new Map<string, NodePlacement>();
  function walk(node: ElkNode, baseX: number, baseY: number): void {
    const x = (node.x ?? 0) + baseX;
    const y = (node.y ?? 0) + baseY;
    if (
      node.id !== '__root__' &&
      typeof node.width === 'number' &&
      typeof node.height === 'number'
    ) {
      placements.set(node.id, { x, y, width: node.width, height: node.height });
    }
    if (node.children) {
      for (const c of node.children) walk(c, x, y);
    }
  }
  walk(result, 0, 0);

  const routes = new Map<string, EdgeRoute>();
  function collectEdges(node: ElkNode & { edges?: ElkEdge[] }): void {
    if (node.edges) {
      for (const e of node.edges) {
        const sec = e.sections?.[0];
        if (!sec) continue;
        const points = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint];
        routes.set(e.id, { points });
      }
    }
    if (node.children) {
      for (const c of node.children as (ElkNode & { edges?: ElkEdge[] })[]) {
        collectEdges(c);
      }
    }
  }
  collectEdges(result);

  return {
    nodes: placements,
    edges: routes,
    width: Math.max(result.width ?? 1, 1),
    height: Math.max(result.height ?? 1, 1),
  };
}
