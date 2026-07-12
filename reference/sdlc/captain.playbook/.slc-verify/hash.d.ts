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
