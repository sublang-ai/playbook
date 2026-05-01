// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { SketchGraph, SketchGraphEdge, SketchGraphNode } from './graph';
import {
  placeholderLayout,
  type NodePlacement,
  type SketchLayout,
} from './layout';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_MARKER_ID = 'sketch-arrow';
const ARROW_REF = `url(#${ARROW_MARKER_ID})`;

const DEFS =
  `<defs>` +
  `<marker id="${ARROW_MARKER_ID}" class="arrow" viewBox="0 0 10 10" refX="9" refY="5" ` +
  `markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
  `<path d="M 0 0 L 10 5 L 0 10 z"/>` +
  `</marker>` +
  `</defs>`;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return c;
    }
  });
}

function stateClasses(node: SketchGraphNode): string {
  const classes = ['state', node.type];
  if (node.type === 'compound' || node.type === 'parallel') {
    classes.push('container');
  }
  return classes.join(' ');
}

function localLabel(id: string): string {
  const parts = id.split('.');
  return parts[parts.length - 1] ?? id;
}

function renderState(node: SketchGraphNode, placement: NodePlacement): string {
  const id = escapeXml(node.id);
  const label = escapeXml(localLabel(node.id));
  const finalInner =
    node.type === 'final'
      ? `<rect class="final-border" x="${placement.x + 4}" y="${placement.y + 4}" ` +
        `width="${placement.width - 8}" height="${placement.height - 8}" rx="4" ry="4" fill="none"/>`
      : '';
  return (
    `<g class="${stateClasses(node)}" data-state-id="${id}" data-state-type="${node.type}">` +
    `<rect x="${placement.x}" y="${placement.y}" width="${placement.width}" height="${placement.height}" rx="6" ry="6"/>` +
    finalInner +
    `<text class="label" x="${placement.x + 8}" y="${placement.y + 16}">${label}</text>` +
    `</g>`
  );
}

function initialChildId(node: SketchGraphNode): string | undefined {
  if (!node.initial) return undefined;
  if (node.parentId === undefined) return node.initial;
  return `${node.id}.${node.initial}`;
}

function renderInitialMarkers(graph: SketchGraph, layout: SketchLayout): string {
  const out: string[] = [];
  for (const node of graph.nodes) {
    const childId = initialChildId(node);
    if (!childId) continue;
    const childBox = layout.nodes.get(childId);
    if (!childBox) continue;

    const ay = childBox.y + childBox.height / 2;
    const startX = childBox.x - 12;
    const endX = childBox.x;
    const ownerId = escapeXml(node.id);

    out.push(
      `<g class="initial-marker" data-initial-of="${ownerId}">` +
        `<line x1="${startX}" y1="${ay}" x2="${endX}" y2="${ay}" marker-end="${ARROW_REF}"/>` +
        `</g>`,
    );
  }
  return out.join('');
}

function renderSelfLoop(
  edge: SketchGraphEdge,
  fromBox: NodePlacement,
  labelText: string,
  attrs: { id: string; event: string; classes: string[] },
): string {
  const x = fromBox.x;
  const y = fromBox.y;
  const w = fromBox.width;
  const startX = x + w * 0.75;
  const endX = x + w * 0.25;
  const arch = 28;
  const path =
    `M ${startX} ${y} ` +
    `C ${startX} ${y - arch} ${endX} ${y - arch} ${endX} ${y}`;
  const labelX = x + w / 2;
  const labelY = y - arch - 4;

  return (
    `<g class="${attrs.classes.concat('self-loop').join(' ')}" data-edge-id="${attrs.id}" data-event="${attrs.event}" data-edge-kind="${edge.kind}">` +
    `<path d="${path}" marker-end="${ARROW_REF}" fill="none"/>` +
    `<text class="event-label" x="${labelX}" y="${labelY}">${escapeXml(labelText)}</text>` +
    `</g>`
  );
}

function renderEdge(edge: SketchGraphEdge, layout: SketchLayout): string {
  const fromBox = layout.nodes.get(edge.from);
  const toBox = layout.nodes.get(edge.to);
  if (!fromBox || !toBox) return '';

  const labelText = edge.event === '' ? '⟨always⟩' : edge.event;
  const id = escapeXml(edge.id);
  const event = escapeXml(edge.event);
  const classes = ['transition', edge.kind];

  if (edge.from === edge.to) {
    return renderSelfLoop(edge, fromBox, labelText, { id, event, classes });
  }

  const sx = fromBox.x + fromBox.width / 2;
  const sy = fromBox.y + fromBox.height / 2;
  const ex = toBox.x + toBox.width / 2;
  const ey = toBox.y + toBox.height / 2;

  return (
    `<g class="${classes.join(' ')}" data-edge-id="${id}" data-event="${event}">` +
    `<polyline points="${sx},${sy} ${ex},${ey}" marker-end="${ARROW_REF}" fill="none"/>` +
    `<text class="event-label" x="${(sx + ex) / 2}" y="${(sy + ey) / 2}">${escapeXml(labelText)}</text>` +
    `</g>`
  );
}

export function renderSketchToString(graph: SketchGraph): string {
  const layout = placeholderLayout(graph);

  const stateMarkup = graph.nodes
    .map((node) => {
      const placement = layout.nodes.get(node.id);
      return placement ? renderState(node, placement) : '';
    })
    .join('');

  const initialMarkup = renderInitialMarkers(graph, layout);
  const edgeMarkup = graph.edges.map((edge) => renderEdge(edge, layout)).join('');

  return (
    `<svg xmlns="${SVG_NS}" class="sketch" viewBox="0 0 ${layout.width} ${layout.height}">` +
    DEFS +
    `<g class="states">${stateMarkup}</g>` +
    `<g class="initial-markers">${initialMarkup}</g>` +
    `<g class="edges">${edgeMarkup}</g>` +
    `</svg>`
  );
}

export function renderSketch(graph: SketchGraph): SVGSVGElement {
  const svgString = renderSketchToString(graph);
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  return doc.documentElement as unknown as SVGSVGElement;
}
