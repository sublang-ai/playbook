<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# sketch: XState Sketch Visualizer

## Intent

This package specifies the XState v5 state-machine visualizer's diagram, live telemetry, lifecycle, architecture, and integration verification.

## External Behavior

### Display

#### sketch-1

When the visualizer is given a state machine, the visualizer shall
display the machine as a diagram in which each state appears as a
labeled element and each transition between states is shown with its
triggering event.

#### sketch-2

While the visualizer is bound to a state machine actor, when the
actor's active state changes, the visualizer shall display only the
currently active state(s) distinctly from inactive states.

#### sketch-3

While the visualizer is bound to a state machine actor, when one or
more transitions fire in the actor, the visualizer shall briefly
highlight each fired transition before returning it to its
unhighlighted style.

#### sketch-4

When a single firing event in the bound actor selects exactly one
transition, the visualizer shall highlight that transition only and
not any sibling transitions whose source, event type, and target
state would otherwise match.

#### sketch-5

When the visualizer is bound to a state machine actor that has
already produced state, the visualizer shall display the actor's
current active state without waiting for a subsequent state change.

### Architecture

#### sketch-6

The visualizer's diagram rendering, telemetry derivation, and
parent-to-renderer transport shall be separable so that telemetry can
be derived in the actor's process and applied to a diagram rendered
in another process.

#### sketch-7

While the visualizer is bound to a state machine, the visualizer
shall compute the diagram's layout once for that machine and shall
not recompute layout in response to telemetry events.

### Telemetry protocol

#### sketch-8

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

#### sketch-9

While the visualizer is bound to a parent-supplied telemetry
source, when the renderer mounts or remounts, the renderer shall
announce readiness so the source can resync the renderer to the
current active state.

#### sketch-10

When the telemetry source binds to a state machine actor, the
source shall produce an initial `active` message derived from the
actor's current snapshot before processing any subsequent
inspection events. The source shall retain its most recently
produced `active` message and re-emit it on every
renderer-readiness announcement; the source shall not retain or
replay `fired` messages.

### Telemetry derivation

#### sketch-11

While the telemetry source is bound to a state machine actor that
invokes child actors, the source shall include only events emitted
by the bound actor itself and shall drop events emitted by any
actor invoked by it, even when both share the same machine root.

#### sketch-12

The telemetry source shall report only the transitions selected by
XState for a firing event and shall not recompute transition
selection in the source.

### Edge identifiers

#### sketch-22

The telemetry source and the renderer shall share a single
identifier namespace for transitions in which each rendered edge
has a unique identifier; identifiers shall distinguish guarded
sibling transitions that share a source state, event, and target
state, and shall distinguish per-target edges of multi-target
transition descriptors that share a source state and event but
target different states.

### Lifecycle

#### sketch-13

While the visualizer is bound to a telemetry source, when the
visualizer is disposed, the visualizer shall detach the source,
abandon any in-flight fired-highlight effects, and clear the
rendered output; subsequent dispose calls shall have no observable
effect.

## Verification

### Display behavior

#### sketch-14

Where the visualizer is mounted with a state machine and bound to a
started actor, when the actor transitions on an event, the diagram
shall mark the new active state distinctly and shall briefly mark
the firing transition as highlighted before clearing that mark (verifying [[sketch-2](#sketch-2)], [[sketch-3](#sketch-3)]).

#### sketch-15

Where two guarded transitions in the diagram have the same source,
event, and target state, when a firing event matches one of them,
the diagram shall highlight only the transition XState selected and
not the sibling (verifying [[sketch-4](#sketch-4)], [[sketch-22](#sketch-22)]).

#### sketch-16

Where a state machine actor has produced one or more state changes
before the renderer attaches, when the renderer mounts and announces
readiness, the renderer shall display the actor's current active
state without waiting for a subsequent state change, and a renderer
remount shall re-display the cached current state (verifying [[sketch-5](#sketch-5)], [[sketch-9](#sketch-9)], [[sketch-10](#sketch-10)]).

### Telemetry Derivation Coverage

#### sketch-17

Where a state machine invokes one or more child actors, when child
actor activity occurs, the telemetry source bound to the parent
actor shall emit no events derived from the child activity (verifying [[sketch-11](#sketch-11)]).

#### sketch-18

Where a parent state and the machine root both define a transition
for the same event, when an event matches both definitions, the
telemetry source shall emit a `fired` message identifying only the
transition XState selected (the parent-owned transition); when the
parent definition is removed and the same event is replayed, the
source shall emit a `fired` message identifying the root-owned
transition (verifying [[sketch-12](#sketch-12)]).

### Lifecycle Coverage

#### sketch-19

When the visualizer is disposed, the visualizer shall detach from
its telemetry source, clear its rendered container, and ignore any
subsequent telemetry messages; a second dispose call shall have no
observable effect (verifying [[sketch-13](#sketch-13)]).

#### sketch-20

Where the actor process and the rendering process are separate, when
the renderer connects, the actor process shall be able to emit
`active` and `fired` messages whose identifiers the renderer can
apply to the same diagram without sharing a runtime (verifying [[sketch-6](#sketch-6)]).

#### sketch-21

Where a state machine has a transition descriptor with multiple
targets (e.g. `target: ['#A', '#B']`), when an event matches that
descriptor, the diagram shall briefly highlight a distinct edge for
each target reached, and the `fired` message identifiers shall
distinguish the per-target edges from one another (verifying [[sketch-3](#sketch-3)], [[sketch-8](#sketch-8)], [[sketch-22](#sketch-22)]).

#### sketch-23

Where the visualizer is mounted with a machine and a layout observer, when telemetry changes its active states and fired transitions, the integration shall fail unless the initial diagram contains every labeled state and event-bearing transition and the machine's layout is computed exactly once across those updates (verifying [[sketch-1](#sketch-1)], [[sketch-7](#sketch-7)]).
