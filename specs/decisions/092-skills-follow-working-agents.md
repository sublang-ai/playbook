<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-092: Skills Follow Working Agents

## Status

Accepted (2026-10-16).

## Context

Cligent can stage one skill source for each supported native agent, but Playbook's closed configuration, session projections and complete calls discard those locators.
The launcher normalizes through a temporary config file, so resolving authored paths there would change their meaning.

## Decision

A top-level skill list supplies the shared default; an agent list replaces it, with an empty list disabling the default.
Resolve each relative locator against its declaring config file before merging layers and preserve absolute locators through host composition, durable execution settings and complete working calls.
Skills are mutable execution capability like browser access: current lists apply on ordinary reopening, while uncertain recovery retains the attempted lists.
Routing, Judge and reporting calls explicitly receive an empty list; working players and bounded Captain recovery preparation receive their configured lists.
The installed Cligent contract owns native staging, validation and permission behavior.

## Consequences

One authored skill can serve different native agents without copying its content into Playbook prompts.
Skill sources remain external dependencies of a session, and callers must keep captured locators available for retry.
Existing sessions with no skill field retain an empty list; older hosts that reject the new optional execution field must be upgraded before opening skill-enabled sessions.
An installed-candidate live workflow must prove both Claude and Codex use a shared external skill, alongside model-free configuration and durable-call coverage.
