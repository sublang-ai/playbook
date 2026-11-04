<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-100: Windows Private Storage Admits Read Grants

## Status

Accepted (2026-11-04) on the owner's direction, after a Spex home that the Codex sandbox had granted read access to was refused at start by Playbook's session store.
Amends [DR-098](098-native-windows-private-storage.md) in the grants and the facts its Windows admission requires: a grant to another principal refuses only when it may change the entry, and the volume need not be local.
Creation, links, special files, multi-link files, POSIX behavior and every other DR-098 decision stand.

## Context

- DR-098 admitted a Windows entry only when its descriptor granted no principal beyond the current user, LocalSystem and built-in Administrators any right, and only on a local volume.
- The Codex Windows sandbox grants its `CodexSandboxUsers` group read and execute access on every top-level entry of the user profile outside a fixed exclusion list that omits `.spex` and `.local` [[1]], so one Codex run makes the Spex home and `~/.local/state/playbook/` fail that admission and the session store and machine identity refuse to open.
- On POSIX, Playbook tightens excess permission bits; on Windows it can only refuse, so a read grant another tool added left the host unable to start.
- Spex, whose home holds Playbook's session store, now admits read grants on Windows and does not require a local volume; a stricter Playbook rule would refuse the storage Spex admits.
- On macOS, a sandboxed agent running as the user reads the same storage without any permission change, so refusing a read grant on Windows protects nothing macOS protects.

## Decision

- On Windows, an entry is private when the current user, LocalSystem or built-in Administrators own it and its descriptor grants no other principal a right to change the entry, its contents, its descriptor or its owner:
  - those rights are writing or appending data or adding a child, writing extended attributes or attributes, deleting the entry or a child, writing its descriptor or owner, and the generic-all, generic-write and maximum-allowed rights that may hold any of them;
  - read, execute and synchronize grants, such as the Codex sandbox's, are admitted;
  - deny entries are admitted whatever their rights.
- Owner and descriptor facts that cannot be read whole, an absent descriptor, or an unsupported entry type still refuse.
- A local volume is no longer required, as POSIX never required one.
- This one rule serves every Windows caller of the private-entry implementation: session files, chunks, replay, assets, leases, repository claims and the machine identity.

## Consequences

- A host on native Windows opens its session store and machine identity after another tool grants itself read access to them.
- An account granted read access can read session content on Windows, as an agent running as the user can on macOS; DR-098's statement that ACL admission does not isolate same-machine processes stands.
- A Windows asset file granted read access to another principal is admitted where DR-098 refused it.
- On a network volume, the descriptor read may not be what the server enforces; the entry is admitted on that descriptor, as POSIX admits a network file on its mode bits.

## References

[1]: https://github.com/openai/codex/blob/12a30d4e6dbd7e527898142b6f4f65fd8070a3b5/codex-rs/windows-sandbox-rs/src/setup.rs#L59-L72 "Codex Windows sandbox setup: user-profile read roots and exclusions"
