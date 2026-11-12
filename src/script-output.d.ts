export declare const SCRIPT_OUTPUT_TAIL_BYTES = 16384;
/**
 * A Windows code page that serves a system as both its ANSI and its OEM
 * code page (DR-103): the label of the decoder that reads it and, where
 * its characters take one or two bytes, the bytes that open a two-byte one.
 */
export interface ScriptOutputCodePage {
    readonly label: string;
    readonly opensTwoBytes?: (byte: number) => boolean;
}
export declare const SCRIPT_OUTPUT_CODE_PAGES: Readonly<Record<string, ScriptOutputCodePage>>;
/**
 * The code page this system's script output is read in, on native Windows
 * where the system has one supported code page for both forms. A system
 * whose ANSI and OEM code pages differ has no single reading of a
 * non-UTF-8 line, so it gets none; neither does one whose registry or
 * decoder is unavailable. Neither value changes while the system runs, so
 * the registry is asked once per process.
 */
export declare function readSystemCodePage(): Promise<ScriptOutputCodePage | undefined>;
/**
 * The bounded record of what a script wrote (DR-103): the last
 * `SCRIPT_OUTPUT_TAIL_BYTES` captured bytes in arrival order, read as text
 * once. NUL goes last, so a UTF-16 line of ASCII text reads as its text and
 * no record holds U+0000.
 */
export declare function createScriptOutputTail(codePage: ScriptOutputCodePage | undefined): {
    push(chunk: Buffer): void;
    read(): {
        output: string;
        outputTruncated: boolean;
    };
};
