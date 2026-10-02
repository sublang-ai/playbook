<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# session-assets: Immutable Owner Assets

## Intent

This package defines the public immutable asset facade and portable attachment and evidence records under [DR-077](../decisions/077-portable-assets-and-inspection.md).

## External Behavior

### session-assets-1

The asset facade shall identify immutable bytes by `sha256:<64 lowercase hexadecimal digits>` and return a closed reference containing `assetId`, nonnegative safe-integer `byteLength`, lowercase MIME `mimeType`, and optional nonempty display `name`, with no filesystem path or owner lifetime dependency.
References to identical bytes may retain distinct display names and MIME metadata without duplicating stored bytes.

### session-assets-2

When a caller imports bytes or a regular file into an owner directory, the facade shall validate the source and size limit, capture byte-array input at admission, hash and write a private temporary file, synchronize it, and publish the immutable digest-named file before returning its reference.
Cancellation and failure shall leave no partially published asset, existing identical content shall be verified before reuse, and symbolic links, hard links, nonregular files or corrupt existing content shall be rejected.
The default per-asset limit shall be 100 MiB, with an explicit positive safe-integer limit configurable by the owning host.

### session-assets-3

When a caller reads or materializes a reference, the facade shall verify the owner's private directory, the asset's private current-user-owned single-link regular file, byte count and SHA-256 digest before returning bytes or an absolute local attachment path.
Invalid references, absent bytes, corrupt bytes and paths escaping the owner shall fail explicitly.
The facade shall provide immutable descriptor lookup by asset ID and a closeable verified reader whose bounded positional reads reuse one content integrity check and reject subsequent file mutation.
The facade shall offer preparation that verifies current-user ownership and real single-link entries, requires sufficient owner permissions, and tightens excess directory and file permissions to `0700` and `0600` through verified handles without changing content.
Materialized paths shall be execution-only values and shall not replace portable references.

### session-assets-4

The facade shall enumerate only verified immutable asset files as relative digest names and byte counts, and shall copy assets between owners by verified bytes without shared links.
An owner may retain unreferenced complete bytes until its own deletion; no import or enumeration shall remove another owner's content.

### session-assets-5

The session host input contract shall preserve exact `text` beside an optional ordered array of asset references, and its visible turn record shall preserve those references independently of the text.
The exported session presentation record union shall include ordinary Cligent records and a `playbook_evidence` record containing the turn, timestamp, call identifier, producing player or preparation actor, optional runtime and tool-use identifiers, and one asset reference.
The call identifier shall name the Playbook trace invocation or a host-owned invocation scope when no trace exists; the optional runtime-session identifier shall name the producing Playbook runtime, not the native provider session.
The stable media URI form shall be `playbook-asset:<assetId>`, resolved only through the owning asset facade.

### session-assets-9

When a host ingests a native agent event through the public facade, the facade shall persist valid base64 media, including whitespace-wrapped data with MIME case and parameters normalized to the bare lowercase media type, as an immutable asset, return its reference beside the event with its source replaced by the stable asset URI and its MIME replaced by the normalized asset MIME, and preserve remote URI media without fetching it.
The facade shall externalize tool-result output whose UTF-8 JSON exceeds 4096 bytes as an exact `application/json` asset reference, infer no media from Markdown or local paths, and reject failed persistence so the host can report unavailable content without replaying the original large payload.

## Verification

### session-assets-10

When integration tests ingest authentic media and tool-result events into a real owner store, they shall verify exact retrievable bytes, preserved event identity and metadata, URI pass-through, malformed-data rejection and bounded replay payloads [[session-assets-9](#session-assets-9)].


### session-assets-6

When integration tests import, read, materialize and copy real files through the public facade, they shall verify byte-exact content identity, independent metadata, atomic publication, cancellation, configurable limits, owner isolation and duplicate reuse [[session-assets-1](#session-assets-1)] [[session-assets-2](#session-assets-2)] [[session-assets-3](#session-assets-3)] [[session-assets-4](#session-assets-4)].

### session-assets-7

When integration tests present malformed references, unsafe filesystem entries and modified content to the public facade, they shall verify explicit rejection without source mutation or deletion of other owner files [[session-assets-1](#session-assets-1)] [[session-assets-2](#session-assets-2)] [[session-assets-3](#session-assets-3)] [[session-assets-4](#session-assets-4)].

### session-assets-8

When a consumer compiles against the packaged asset and session presentation exports and round-trips attachment-only input and evidence records through JSON, it shall verify exact empty text, complete attachment metadata, origin information and stable asset URI resolution [[session-assets-5](#session-assets-5)].
