<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# SKETCH: XState Sketch Visualizer

## Intent

This spec defines the system behavior and contracts of the XState
sketch visualizer that delivers the user-visible behavior in
[user/sketch.md](../user/sketch.md).

The package targets XState v5 actors; XState is essential to the
package's intent.

## Architecture

### SKETCH-6

The visualizer's diagram rendering, telemetry derivation, and
parent-to-renderer transport shall be separable so that telemetry can
be derived in the actor's process and applied to a diagram rendered
in another process.

### SKETCH-7

While the visualizer is bound to a state machine, the visualizer
shall compute the diagram's layout once for that machine and shall
not recompute layout in response to telemetry events.

## Telemetry protocol

### SKETCH-8

Live telemetry derived from the bound actor shall consist of two
message kinds — an `active` message carrying the identifiers of the
currently active states (including ancestor containers), and a
`fired` message carrying the identifiers of one or more transitions
fired by a single firing event in the bound actor. Effect-control
messages such as fired-clear and renderer-readiness signaling are
permitted in the same protocol. All live telemetry messages,
whether actor-derived or effect-control, shall carry only diagram
identifiers; they shall not carry actor context, runtime event
payloads, or any other actor state.

### SKETCH-9

While the visualizer is bound to a parent-supplied telemetry
source, when the renderer mounts or remounts, the renderer shall
announce readiness so the source can resync the renderer to the
current active state.

### SKETCH-10

When the telemetry source binds to a state machine actor, the
source shall produce an initial `active` message derived from the
actor's current snapshot before processing any subsequent
inspection events. The source shall retain its most recently
produced `active` message and re-emit it on every
renderer-readiness announcement; the source shall not retain or
replay `fired` messages.

## Telemetry derivation

### SKETCH-11

While the telemetry source is bound to a state machine actor that
invokes child actors, the source shall include only events emitted
by the bound actor itself and shall drop events emitted by any
actor invoked by it, even when both share the same machine root.

### SKETCH-12

The telemetry source shall report only the transitions selected by
XState for a firing event and shall not recompute transition
selection in the source.

## Edge identifiers

### SKETCH-22

The telemetry source and the renderer shall share a single
identifier namespace for transitions in which each rendered edge
has a unique identifier; identifiers shall distinguish guarded
sibling transitions that share a source state, event, and target
state, and shall distinguish per-target edges of multi-target
transition descriptors that share a source state and event but
target different states.

## Lifecycle

### SKETCH-13

While the visualizer is bound to a telemetry source, when the
visualizer is disposed, the visualizer shall detach the source,
abandon any in-flight fired-highlight effects, and clear the
rendered output; subsequent dispose calls shall have no observable
effect.
