import type { Captain, CaptainRunResult } from '@sublang/cligent/tmux-play';
declare module '@sublang/cligent/tmux-play' {
    interface CaptainContext {
        callCaptain(prompt: string, options?: {
            readonly visibility?: 'hidden' | 'visible';
        }): Promise<CaptainRunResult>;
    }
}
export type CodeOptions = Record<string, never>;
export declare function validateCodeOptions(captainOptions: unknown): CodeOptions;
export default function createCodeTmuxPlayCaptain(options: unknown): Captain;
