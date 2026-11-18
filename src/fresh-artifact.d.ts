interface CommonJsModule {
    require(id: string): unknown;
}
interface LexicalRequire {
    (id: string): unknown;
    resolve(id: string): string;
}
/** @internal Keep native Module objects and delegate through a revision-unique request. */
export declare function installRevisionRequire(module: CommonJsModule, lexicalRequire: LexicalRequire, url: string): void;
/** Revision identity propagates through owned files; package runtimes keep their own identity. */
export declare function freshArtifactUrl(path: string, root?: string): string;
/** Import one registry revision with the same scoped dependency identity. */
export declare function importFreshArtifact(path: string, root?: string): Promise<Record<string, unknown>>;
/** Registry preparation preserves the host's canonical locator contract. */
export declare function canonicalFreshArtifactUrl(path: string, root?: string): string;
export {};
