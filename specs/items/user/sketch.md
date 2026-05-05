<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# SKETCH: XState Sketch Visualizer

## Intent

This spec defines the user-visible behavior of a state-machine
visualizer: a component that renders a state machine as a diagram and
shows the activity of a state machine actor on that diagram.

The package targets XState v5 actors; XState is essential to the
package's intent.

## Display

### SKETCH-1

When the visualizer is given a state machine, the visualizer shall
display the machine as a diagram in which each state appears as a
labeled element and each transition between states is shown with its
triggering event.

### SKETCH-2

While the visualizer is bound to a state machine actor, when the
actor enters a state, the visualizer shall display that state
distinctly from inactive states and shall remove the distinct
display from the previously active state.

### SKETCH-3

While the visualizer is bound to a state machine actor, when one or
more transitions fire in the actor, the visualizer shall briefly
highlight each fired transition before returning it to its
unhighlighted style.

### SKETCH-4

When a single firing event in the bound actor selects exactly one
transition, the visualizer shall highlight that transition only and
not any sibling transitions whose source, event type, and target
state would otherwise match.

### SKETCH-5

When the visualizer is bound to a state machine actor that has
already produced state, the visualizer shall display the actor's
current active state without waiting for a subsequent state change.
