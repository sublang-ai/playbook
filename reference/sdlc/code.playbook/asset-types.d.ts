// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

/** Cancellation only needs the standard synchronous abort check. */
export interface AssetAbortSignal { throwIfAborted(): void; }
export type AssetId = `sha256:${string}`;
export interface SessionAssetRef {
  readonly assetId: AssetId;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly name?: string;
}
export type AssetImport = (
  | { readonly bytes: Uint8Array; readonly path?: never }
  | { readonly path: string; readonly bytes?: never }
) & { readonly mimeType: string; readonly name?: string; readonly signal?: AssetAbortSignal };
export interface AssetFile {
  readonly assetId: AssetId;
  /** Relative filename within this owner's asset directory. */
  readonly path: string;
  readonly byteLength: number;
  readonly metadataPath: string;
}
export interface AssetReader {
  readonly reference: SessionAssetRef;
  read(options: { readonly offset: number; readonly length: number; readonly signal?: AssetAbortSignal }): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface SessionTurnInput {
  readonly text: string;
  readonly attachments?: readonly SessionAssetRef[];
}
