// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Generates docs/coding-fsm-mid-run.svg — the README's mid-run screenshot.
// Uses the public Diagram-layer API only: extractGraph + renderSketchToString
// (DR-002 §3, §5). The script then injects the same theme styles as
// styles.css inline so the SVG renders standalone on GitHub, and adds
// `.active` / `.fired` classes to a chosen state and edge to simulate a
// snapshot the live demo would produce mid-run. Re-run after machine or
// theme changes; commit the result.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codingMachine } from '../demo/coding.fsm';
import { extractGraph } from '../src/graph';
import { renderSketchToString } from '../src/render';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, '../docs/coding-fsm-mid-run.svg');

// IDs are dotted paths from the machine root. Children of the top-level
// machine are bare names (e.g. `planAndImplement`), not `coding.planAndImplement`.
const ACTIVE_STATE_ID = 'reviewCodeCommit';
const FIRED_FROM = 'planAndImplement';
const FIRED_EVENT_PREFIX = 'xstate.done.actor';

const INLINE_STYLES = `<style>
  .sketch { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; font-size: 12px; }
  .state > rect { fill: #fff; stroke: #c9d3da; stroke-width: 1; }
  .state.compound > rect, .state.parallel > rect { fill: #eef3f7; }
  .state.final > rect { stroke: #0f172a; }
  .state.final .final-border { stroke: #0f172a; stroke-width: 1; fill: none; }
  .state .label { fill: #172026; font-weight: 500; }
  .state.active > rect { fill: #dbe9ff; stroke: #2563eb; stroke-width: 2; }
  .state.active .label { fill: #2563eb; }
  .initial-marker line { stroke: #5b6b78; stroke-width: 1.25; fill: none; }
  .arrow path { fill: #5b6b78; }
  .transition path, .transition polyline { stroke: #5b6b78; stroke-width: 1.25; fill: none; }
  .transition .event-label { fill: #5b6b78; }
  .transition.fired path, .transition.fired polyline { stroke: #d97706; stroke-width: 2.25; }
  .transition.fired .event-label { fill: #d97706; font-weight: 600; }
</style>`;

const graph = extractGraph(codingMachine);

const firedEdge = graph.edges.find(
  (e) => e.from === FIRED_FROM && e.event.startsWith(FIRED_EVENT_PREFIX),
);
if (!firedEdge) {
  throw new Error(`Could not find a fired edge from ${FIRED_FROM}`);
}
if (!graph.nodes.some((n) => n.id === ACTIVE_STATE_ID)) {
  throw new Error(`Could not find active state ${ACTIVE_STATE_ID}`);
}

let svg = renderSketchToString(graph);

svg = svg.replace('<defs>', `${INLINE_STYLES}<defs>`);

function injectClass(
  source: string,
  attr: string,
  attrValue: string,
  extraClass: string,
): string {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<g class="([^"]*)"([^>]*?) ${attr}="${escaped}"`);
  const match = re.exec(source);
  if (!match) {
    throw new Error(`Could not find <g> with ${attr}="${attrValue}"`);
  }
  const replaced = `<g class="${match[1]} ${extraClass}"${match[2]} ${attr}="${attrValue}"`;
  return source.replace(match[0], replaced);
}

svg = injectClass(svg, 'data-state-id', ACTIVE_STATE_ID, 'active');
svg = injectClass(svg, 'data-edge-id', firedEdge.id, 'fired');

writeFileSync(OUT_PATH, svg + '\n');
console.log(`Wrote ${OUT_PATH} (${svg.length} chars)`);
