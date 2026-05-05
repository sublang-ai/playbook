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

The telemetry stream shall consist of two event kinds — an `active`
message carrying the identifiers of the currently active states
(including ancestor containers), and a `fired` message carrying the
identifiers of one or more transitions fired by a single firing
event in the bound actor.

### SKETCH-9

While the visualizer is bound to a parent-supplied telemetry source,
when the renderer mounts or remounts, the renderer shall announce
readiness and the source shall re-emit its most recently produced
`active` message so the renderer displays the current state without
waiting for the next state change.

### SKETCH-10

The telemetry source shall retain its most recently produced
`active` message and re-emit it on every renderer-readiness
announcement; the source shall not retain or replay `fired`
messages.

## Telemetry derivation

### SKETCH-11

While the telemetry source is attached to a state machine actor that
invokes child actors, the source shall include only events whose
actor reference equals the bound actor and shall drop events from
any other actor in the system, including invoked children.

### SKETCH-12

The telemetry source shall report exactly the transitions selected
by XState for a firing event, without recomputing transition
selection; the deepest-owner rule for transitions matching the same
event is observed by reading XState's selection rather than
implemented in the source.

## Lifecycle

### SKETCH-13

While the visualizer is bound to a telemetry source, when the
visualizer is disposed, the visualizer shall detach the source,
cancel any pending fired-highlight timers, and clear the rendered
container; subsequent dispose calls shall have no observable
effect.
