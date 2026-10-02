/** A SHA-256 content hash as `sha256:<64 lowercase hex>` (DR-007). */
export type Hash = `sha256:${string}`;
/** Hashes exact bytes as `sha256:<64 lowercase hex>`, applying no normalization (DR-007). */
export declare function hashBytes(bytes: Uint8Array): Hash;
/**
 * Reads a file and hashes its exact bytes (DR-007).
 *
 * Reads with no encoding so the bytes are hashed verbatim, without line-ending
 * or text transformation.
 */
export declare function hashFile(path: string): Promise<Hash>;
/** Reports whether a string is a well-formed `sha256:<64 lowercase hex>` hash (DR-007). */
export declare function isHash(value: string): value is Hash;
/**
 * Orders two strings by their exact UTF-8 bytes (DR-007).
 *
 * This is the ordering every hashed tree record is sorted and validated by,
 * so it belongs beside the hashes themselves: a second implementation that
 * disagreed on one code point would silently change identities.
 */
export declare function compareUtf8(left: string, right: string): number;
/** One tree entry: its path, and its frozen serialized form. */
export interface TreeEntryRecord {
    readonly path: string;
    readonly serialized: string;
}
/**
 * Serializes one tree entry as `[kind,path,identity]` (DR-007).
 *
 * Every tree identity — whatever walker produced its entries — is this exact
 * encoding, so it is written once beside the hash it feeds.
 */
export declare function serializeTreeRecord(kind: 'file' | 'symlink', path: string, identity: string): string;
/** Hashes tree entries in UTF-8 path order, one LF between entries. */
export declare function hashTreeRecords(records: readonly TreeEntryRecord[]): Hash;
