import type { Captain } from '@sublang/cligent/tmux-play';
import type { PlaybookRuntime } from '@sublang/playbook/runtime';
import type { PlaybookSummaryPolicy, RegistryPlayer } from './code.registry.js';
export interface CreatePlaybookRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export interface PlaybookCaptainDeps {
    loadModule?: (specifier: string) => Promise<unknown>;
    createSessionId?: () => string;
    createCaptainRuntime?: (options: {
        readonly enabledPlaybooks: readonly {
            readonly id: string;
            readonly command: string;
            readonly intent: string;
        }[];
    }) => PlaybookRuntime;
}
export interface PlaybookCaptainRegistryEntry {
    id: string;
    command: string;
    intent: string;
    requiredRoleIds: readonly string[];
    summaryPolicy?: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): unknown;
    createRuntime(options: CreatePlaybookRuntimeOptions): PlaybookRuntime;
}
export declare function createPlaybookCaptainShell(options: unknown, deps?: PlaybookCaptainDeps): Captain;
export default createPlaybookCaptainShell;
