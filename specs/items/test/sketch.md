<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# SKETCH: XState Sketch Visualizer

## Intent

This spec defines integration tests that verify the user-visible
behavior in [user/sketch.md](../user/sketch.md) and the system
contracts in [dev/sketch.md](../dev/sketch.md) of the XState sketch
visualizer.

The package targets XState v5 actors; XState is essential to the
package's intent.

## Display behavior

### SKETCH-14
Verifies: [SKETCH-2](../user/sketch.md#sketch-2), [SKETCH-3](../user/sketch.md#sketch-3)

Where the visualizer is mounted with a state machine and bound to a
started actor, when the actor transitions on an event, the diagram
shall mark the new active state distinctly and shall briefly mark
the firing transition as highlighted before clearing that mark.

### SKETCH-15
Verifies: [SKETCH-4](../user/sketch.md#sketch-4)

Where two guarded transitions in the diagram have the same source,
event, and target state, when a firing event matches one of them,
the diagram shall highlight only the transition XState selected and
not the sibling.

### SKETCH-16
Verifies: [SKETCH-5](../user/sketch.md#sketch-5), [SKETCH-9](../dev/sketch.md#sketch-9), [SKETCH-10](../dev/sketch.md#sketch-10)

Where a state machine actor has produced one or more state changes
before the renderer attaches, when the renderer mounts and announces
readiness, the renderer shall display the actor's current active
state without waiting for a subsequent state change, and a renderer
remount shall re-display the cached current state.

## Telemetry derivation

### SKETCH-17
Verifies: [SKETCH-11](../dev/sketch.md#sketch-11)

Where a state machine invokes one or more child actors, when child
actor activity occurs, the telemetry source bound to the parent
actor shall emit no events derived from the child activity.

### SKETCH-18
Verifies: [SKETCH-12](../dev/sketch.md#sketch-12)

Where a parent state and the machine root both define a transition
for the same event, when an event matches both definitions, the
telemetry source shall emit a `fired` message identifying only the
transition XState selected (the parent-owned transition); when the
parent definition is removed and the same event is replayed, the
source shall emit a `fired` message identifying the root-owned
transition.

## Lifecycle

### SKETCH-19
Verifies: [SKETCH-13](../dev/sketch.md#sketch-13)

When the visualizer is disposed, the visualizer shall detach from
its telemetry source, clear its rendered container, and ignore any
subsequent telemetry messages; a second dispose call shall have no
observable effect.

### SKETCH-20
Verifies: [SKETCH-6](../dev/sketch.md#sketch-6)

Where the actor process and the rendering process are separate, when
the renderer connects, the actor process shall be able to emit
`active` and `fired` messages whose identifiers the renderer can
apply to the same diagram without sharing a runtime.
