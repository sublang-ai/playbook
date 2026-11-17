export declare const BUILD_MANIFEST_SCHEMA: "sublang.slc.build.v1";
export declare const BUILD_MANIFEST_MARKER = "// @sublang/slc-build-manifest ";
export interface RuntimePackageIdentity {
    name: string;
    version: string;
    root: string;
    identityFiles: {
        path: string;
        sha256: string;
    }[];
    contentHash: string;
}
export interface ArtifactEnvironment {
    playbook: RuntimePackageIdentity;
    xstate: RuntimePackageIdentity;
    runtimeAbi: number;
    supportedArtifactSchemas: number[];
}
export interface BuildFile {
    path: string;
    kind: 'entry' | 'fsm' | 'linked' | 'runtime-support' | 'gears' | 'checker-evidence';
    format: string;
    sha256: string;
}
export interface WorkflowBuildManifest {
    schema: typeof BUILD_MANIFEST_SCHEMA;
    entry: {
        path: string;
        format: 'esm-javascript' | 'typescript';
    };
    compiler: {
        package: string;
        version: string;
        buildIdentity: string;
    };
    runtime: {
        playbook: RuntimePackageIdentity;
        xstate: RuntimePackageIdentity;
        runtimeAbi: number;
        artifactSchema: number;
    };
    inputs: {
        path: string;
        sha256: string;
        snapshot: string;
    }[];
    files: BuildFile[];
    verification: {
        checks: {
            name: string;
            status: 'passed';
            evidence: string;
        }[];
        attemptRecord: string;
    };
}
export declare class ArtifactEnvironmentError extends Error {
    readonly remedy: string;
    readonly category = "environment";
    constructor(message: string, remedy?: string);
}
/** Resolve both runtime packages from the selected Playbook, never from the user's cwd. */
export declare function inspectArtifactEnvironment(options?: {
    playbookRoot?: string;
}): Promise<ArtifactEnvironment>;
/** Preflight every destination before mutation; directory junctions need no Windows symlink privilege. */
export declare function prepareArtifactEnvironment(options: {
    artifactDir: string;
    environment?: ArtifactEnvironment;
    authority?: 'compiler' | 'host';
    provision?: boolean;
}): Promise<{
    environment: ArtifactEnvironment;
    createdLinks: {
        path: string;
        target: string;
    }[];
}>;
export declare function locateBuildManifest(entryPath: string): Promise<string | undefined>;
/** Runtime validation intentionally does not read Source snapshots, GEARS, tests or compiler logs. */
export declare function validateArtifactManifest(entryPath: string): Promise<WorkflowBuildManifest | undefined>;
/** Canonical module path for host-side configured-registry integration. */
export declare function artifactEntryPath(specifier: string): string;
export { importFreshArtifact } from './fresh-artifact.js';
export { inspectArtifactFiles } from './artifact-files.js';
