import type { Captain } from '@sublang/cligent/tmux-play';
import type { PlaybookRuntime } from './code.playbook.js';
import { type PlaybookSummaryPolicy, type RegistryPlayer } from './code.registry.js';
export interface CreatePlaybookRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export interface PlaybookCaptainDeps {
    loadModule?: (specifier: string) => Promise<unknown>;
}
export interface PlaybookCaptainRegistryEntry {
    id: string;
    command: string;
    intent: string;
    requiredRoleIds: readonly string[];
    idleStateId: string;
    finalStateId: string;
    parkStateIds: readonly string[];
    summaryPolicy?: PlaybookSummaryPolicy;
    validateOptions(captainOptions: unknown): unknown;
    createRuntime(options: CreatePlaybookRuntimeOptions): PlaybookRuntime;
}
export declare const playbookCaptainRegistry: readonly PlaybookCaptainRegistryEntry[];
export declare function createPlaybookCaptainShell(options: unknown, registry?: readonly PlaybookCaptainRegistryEntry[], deps?: PlaybookCaptainDeps): Captain;
export default createPlaybookCaptainShell;
