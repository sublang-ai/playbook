<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Legacy session fixtures

Sessions in the two physical formats earlier than schema 9 ([DR-111](../../../../../specs/decisions/111-a-session-is-a-manifest-and-a-replay-log.md)), written by the Playbook 19.1.0 store before its writers were removed.
They are the inputs of the conversion command's tests; tests copy them before use and never change them in place.
`expected/` holds what that store read from each: the logical manifest and the exact replay bytes, the conversion's required output.

| Session | Format | Contents |
| --- | --- | --- |
| `8a000000-…-000000000001` | schema 8 chunks | settled, two turns, one asset, provider hints, a replay record and a journal entry over the 16 KiB inline bound |
| `8a000000-…-000000000002` | schema 8 chunks | uncertain: one settled turn, then a begun turn with saved progress |
| `8a000000-…-000000000003` | schema 8 chunks | history-only, written through the bounded encoder |
| `7a000000-…-000000000001` | schema 7 monolithic | settled, provider hints, one complete record after the checkpoint |
| `7a000000-…-000000000002` | schema 7 monolithic | as above, plus a torn final line |

Lease directories were removed after writing; `.gitattributes` keeps every byte exact on checkout.
