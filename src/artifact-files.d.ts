import type { BuildFile } from './artifact-environment.js';
/** The executable closure is shared by publication and pre-import validation. */
export declare function inspectArtifactFiles(options: {
    artifactDir: string;
    entry: string;
    fsm: string;
    linked: string;
}): Promise<BuildFile[]>;
