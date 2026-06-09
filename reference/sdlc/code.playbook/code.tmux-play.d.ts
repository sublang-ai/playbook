import type { Captain } from '@sublang/cligent/tmux-play';
export interface CodeOptions {
    committer?: 'coder' | 'reviewer';
}
export declare function validateCodeOptions(captainOptions: unknown): CodeOptions;
export default function createCodeTmuxPlayCaptain(options: unknown): Captain;
