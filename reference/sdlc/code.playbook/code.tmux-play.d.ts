import type { Captain } from '@sublang/cligent/tmux-play';
export { codeCopyPasteGuardNames, codeStateCountLabels, codePlaybookRegistryEntry, createCodeRuntimeOptions, validateCodeOptions, } from './code.registry.js';
export type { CodeOptions, CodePlaybookRegistryEntry, CreateCodeRuntimeOptions, RegistryPlayer, } from './code.registry.js';
export default function createCodeTmuxPlayCaptain(options: unknown): Captain;
