import type { Captain } from '@sublang/cligent/tmux-play';
import type { PlaybookRuntime } from './code.playbook.js';
import { type RegistryPlayer } from './code.registry.js';
export interface CreatePlaybookRuntimeOptions {
    captainOptions: unknown;
    players: readonly RegistryPlayer[];
}
export interface PlaybookCaptainRegistryEntry {
    id: string;
    command: string;
    intent: string;
    idleStateId: string;
    finalStateId: string;
    copyPasteGuardNames: readonly string[];
    stateCountLabels?: Readonly<Record<string, string>>;
    validateOptions(captainOptions: unknown): unknown;
    createRuntime(options: CreatePlaybookRuntimeOptions): PlaybookRuntime;
}
export declare const playbookCaptainRegistry: readonly PlaybookCaptainRegistryEntry[];
export declare function createPlaybookCaptainShell(options: unknown, registry?: readonly PlaybookCaptainRegistryEntry[]): Captain;
export default createPlaybookCaptainShell;
