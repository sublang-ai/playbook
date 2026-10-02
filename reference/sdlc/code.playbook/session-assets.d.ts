// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentEvent, Attachment } from '@sublang/cligent';
import type { TmuxPlayRecord } from '@sublang/cligent/tmux-play';

import type { AssetId, AssetImport, AssetFile, AssetReader, SessionAssetRef, SessionTurnInput } from './asset-types.js';
export type { AssetId, AssetImport, AssetFile, AssetReader, SessionAssetRef, SessionTurnInput } from './asset-types.js';

export interface OwnerAssetStore {
  readonly directory: string;
  /** Verify ownership and tighten Git checkout permissions without changing content. */
  prepare(): Promise<void>;
  importAsset(input: AssetImport): Promise<SessionAssetRef>;
  describeAsset(assetId: AssetId): Promise<SessionAssetRef>;
  openAsset(reference: SessionAssetRef | AssetId, options?: { readonly signal?: AbortSignal }): Promise<AssetReader>;
  readAsset(reference: SessionAssetRef | AssetId, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  resolveAttachment(reference: SessionAssetRef, options?: { readonly signal?: AbortSignal }): Promise<Attachment>;
  copyAsset(source: Pick<OwnerAssetStore, 'readAsset'>, reference: SessionAssetRef, options?: { readonly signal?: AbortSignal }): Promise<SessionAssetRef>;
  listAssets(): Promise<readonly AssetFile[]>;
}
export declare const DEFAULT_MAX_ASSET_BYTES: number;
export declare function createAssetStore(options: { readonly directory: string; readonly maxAssetBytes?: number }): OwnerAssetStore;
export declare function validateAssetRef(value: unknown): SessionAssetRef;
export declare function validateAssetRefs(value: unknown): readonly SessionAssetRef[];
export declare function normalizeSessionTurnInput(value: string | SessionTurnInput): { readonly text: string; readonly attachments: readonly SessionAssetRef[] };
export declare function assetUri(reference: SessionAssetRef): string;
export declare function parseAssetUri(value: string): AssetId | undefined;
/** Throws if native content cannot be persisted; the caller must report it as unavailable. */
export declare function externalizeAgentEvent(store: Pick<OwnerAssetStore, 'importAsset'>, event: AgentEvent): Promise<{ readonly event: AgentEvent; readonly asset?: SessionAssetRef }>;

export type SessionTurnStartedRecord = Omit<Extract<TmuxPlayRecord, { type: 'turn_started' }>, 'turn'> & {
  readonly turn: Extract<TmuxPlayRecord, { type: 'turn_started' }>['turn'] & {
    readonly attachments?: readonly SessionAssetRef[];
  };
};
export interface PlaybookEvidenceRecord {
  readonly type: 'playbook_evidence';
  readonly timestamp: number;
  readonly turnId: number;
  /** Playbook trace call identity, or a host-owned invocation-scope identity. */
  readonly callId: string;
  readonly origin: {
    readonly kind: 'player' | 'preparation';
    readonly actorId: string;
    /** Producing Playbook runtime identity, not the native provider session. */
    readonly runtimeSessionId?: string;
    readonly toolUseId?: string;
  };
  readonly asset: SessionAssetRef;
}
/** Known host presentation records. Unknown replay records remain opaque JSON. */
export type SessionRecord = Exclude<TmuxPlayRecord, { type: 'turn_started' }> | SessionTurnStartedRecord | PlaybookEvidenceRecord;
