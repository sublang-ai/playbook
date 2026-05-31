import type { Captain } from '@sublang/cligent/tmux-play';
export type CodeOptions = Record<string, never>;
export declare function validateCodeOptions(captainOptions: unknown): CodeOptions;
export default function createCodeTmuxPlayCaptain(options: unknown): Captain;
