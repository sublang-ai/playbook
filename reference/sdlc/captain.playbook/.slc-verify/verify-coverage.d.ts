import { type MachineConfigLike } from './verify.js';
/** The `gears2fsm`-mandated captain actor name a machine declares. */
export declare const CAPTAIN_ACTOR = "captain";
/** The minimal machine surface the coverage driver needs. */
interface MachineLike {
    config: MachineConfigLike & {
        id?: string;
    };
    provide(implementations: {
        actors: Record<string, unknown>;
    }): MachineLike;
    /** XState exposes `setup()`-registered guards here. */
    implementations?: {
        guards?: Record<string, unknown>;
    };
    /** XState's resolved state nodes expose the actual invocation actor ids. */
    root?: ResolvedStateNodeLike;
}
interface ResolvedStateNodeLike {
    states?: Record<string, ResolvedStateNodeLike>;
    invoke?: Array<{
        id?: string;
    }>;
}
/**
 * Finds the XState machine an `fsm` module exports — the export carrying a
 * `.config.states` and a `.provide` — so the coverage driver can supply the
 * scripted captain.
 *
 * @throws when the module exports no such machine.
 */
export declare function findMachine(fsmModule: unknown): MachineLike;
/** Mines identifier-like string literals from an artifact's source text. */
export declare function identifierLiterals(sourceText: string): string[];
/**
 * Reports whether a bounded search finds a context/output assignment under
 * which the guard passes, seeding candidate values from the guard's source and
 * the caller's extra candidates (typically the machine's state keys and the
 * artifact's identifier literals, since typed routing fields hold values that
 * guards compare against helper-bound constants).
 *
 * A conjunctive guard short-circuits, so each probe pass reveals at most one
 * new field read; the search deepens iteratively — assign a discovered field
 * each candidate value, re-probe for the next read — within a global probe
 * budget, and an exhausted budget reports unsatisfiable ("under probing").
 */
export declare function guardSatisfiable(guard: (arg: {
    context: unknown;
    event: unknown;
}) => unknown, baseOutput: Record<string, unknown>, extraValues?: readonly unknown[]): boolean;
/**
 * Derives a conservative Vitest timeout from the same bounded work performed
 * by {@link checkFsmCoverage}. It includes every possible async settle window,
 * the bounded parallel-combination surface, an allowance for each worst-case
 * guard search, and a final scheduling margin. Generated tests use this instead
 * of Vitest's five-second default.
 */
export declare function fsmCoverageTestTimeout(fsmModule: unknown): number;
/**
 * Checks transition coverage over a compiled `playbook` artifact's machine
 * (VERIFY-6) and returns findings (empty when every declared transition is
 * reachable). Requires the machine to declare the `gears2fsm` surfaces it
 * drives through: the `BOSS_INTERRUPT` root event and the Boss-reply wait
 * state.
 */
export declare function checkFsmCoverage(fsmModule: unknown, opts?: {
    /** The artifact's source text, mined for routing-value candidates. */
    sourceText?: string;
}): Promise<string[]>;
/**
 * Builds a per-artifact vitest module running the transition-coverage check
 * beside the artifacts (VERIFY-6).
 */
export declare function generateFsmCoverageTest(opts: {
    basename: string;
    /** NodeNext import specifier for the compiled FSM. */
    fsmModule: string;
    /** Physical TypeScript source path, relative to the generated test. */
    fsmSourceFile: string;
    verifyModule: string;
}): string;
/**
 * Emits the transition-coverage test beside a compiled `playbook` artifact
 * (VERIFY-6): validates the produced `fsm` drives cleanly, then writes
 * `<basename>.fsm.coverage.test.ts` and returns its path with any coverage
 * findings as diagnostics.
 *
 * @throws when the `fsm` artifact cannot be imported or exports no machine.
 */
export declare function emitFsmCoverageTest(opts: {
    artifactDir: string;
    basename: string;
    verifyModule?: string;
}): Promise<{
    path: string;
    diagnostics: string[];
}>;
export {};
