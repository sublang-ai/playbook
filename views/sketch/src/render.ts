// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { SketchGraph, SketchGraphEdge, SketchGraphNode } from './graph';
import {
  placeholderLayout,
  type NodePlacement,
  type SketchLayout,
} from './layout';

const SVG_NS = 'http://www.w3.org/2000/svg';

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
  return (
    `<g class="${stateClasses(node)}" data-state-id="${id}" data-state-type="${node.type}">` +
    `<rect x="${placement.x}" y="${placement.y}" width="${placement.width}" height="${placement.height}" rx="6" ry="6"/>` +
    `<text class="label" x="${placement.x + 8}" y="${placement.y + 16}">${label}</text>` +
    `</g>`
  );
}

function renderEdge(edge: SketchGraphEdge, layout: SketchLayout): string {
  const fromBox = layout.nodes.get(edge.from);
  const toBox = layout.nodes.get(edge.to);
  if (!fromBox || !toBox) return '';

  const fx = fromBox.x + fromBox.width / 2;
  const fy = fromBox.y + fromBox.height / 2;
  const tx = toBox.x + toBox.width / 2;
  const ty = toBox.y + toBox.height / 2;

  const labelText = edge.event === '' ? '⟨always⟩' : edge.event;
  const id = escapeXml(edge.id);
  const event = escapeXml(edge.event);

  return (
    `<g class="transition ${edge.kind}" data-edge-id="${id}" data-event="${event}">` +
    `<line x1="${fx}" y1="${fy}" x2="${tx}" y2="${ty}"/>` +
    `<text class="event-label" x="${(fx + tx) / 2}" y="${(fy + ty) / 2}">${escapeXml(labelText)}</text>` +
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

  const edgeMarkup = graph.edges.map((edge) => renderEdge(edge, layout)).join('');

  return (
    `<svg xmlns="${SVG_NS}" class="sketch" viewBox="0 0 ${layout.width} ${layout.height}">` +
    `<g class="states">${stateMarkup}</g>` +
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
