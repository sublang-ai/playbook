/** Revision identity propagates through local imports; package runtimes keep their own identity. */
export declare function freshArtifactUrl(path: string, root?: string): string;
/** Import one registry revision with the same scoped dependency identity. */
export declare function importFreshArtifact(path: string, root?: string): Promise<Record<string, unknown>>;
/** Registry preparation preserves the host's canonical locator contract. */
export declare function canonicalFreshArtifactUrl(path: string, root?: string): string;
