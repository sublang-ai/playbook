// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// What a script step's command wrote, as the text its `playbook.script`
// record carries (DR-103): the bounded tail of the captured bytes, read
// once. Internal to the shared factory's script actor.

import { isUtf8 } from 'node:buffer';
import { execFile } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify, TextDecoder } from 'node:util';

export const SCRIPT_OUTPUT_TAIL_BYTES = 16384;

/** The two descriptors of a pipe: its read end and its write end. */
export interface ScriptOutputPipe {
  readonly read: number;
  readonly write: number;
}

/**
 * A pipe of the kernel's own for a command's stdout and stderr (DR-103).
 * Node's `pipe` stdio is a socket pair, and Linux refuses to open a socket
 * again by path, so a command that writes to `/dev/stderr` fails on one. A
 * FIFO opened at both ends is a pipe, and stays one once its name is gone.
 * None on native Windows, whose `sh` serves those paths itself, and none
 * where the FIFO cannot be made: the caller then falls back on Node's.
 */
export async function openScriptOutputPipe(): Promise<
  ScriptOutputPipe | undefined
> {
  if (process.platform === 'win32') return undefined;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'playbook-script-output-'));
    const path = join(dir, 'pipe');
    await promisify(execFile)('mkfifo', [path]);
    // The read end first, and without waiting for a writer: the write end
    // then opens at once. The reader's stdin is set to block when it starts.
    const read = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      return { read, write: openSync(path, constants.O_WRONLY) };
    } catch {
      closeSync(read);
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Closes this process's copies of a pipe's two ends. */
export function closeScriptOutputPipe(pipe: ScriptOutputPipe | undefined): void {
  if (pipe === undefined) return;
  for (const end of [pipe.read, pipe.write]) {
    try {
      closeSync(end);
    } catch {
      // Already closed: nothing is left to release.
    }
  }
}

/**
 * A Windows code page that serves a system as both its ANSI and its OEM
 * code page (DR-103): the label of the decoder that reads it and, where
 * its characters take one or two bytes, the bytes that open a two-byte one.
 */
export interface ScriptOutputCodePage {
  readonly label: string;
  readonly opensTwoBytes?: (byte: number) => boolean;
}
export const SCRIPT_OUTPUT_CODE_PAGES: Readonly<
  Record<string, ScriptOutputCodePage>
> = {
  '874': { label: 'windows-874' },
  '932': {
    label: 'shift_jis',
    opensTwoBytes: (byte) =>
      (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc),
  },
  '936': { label: 'gbk', opensTwoBytes: (byte) => byte >= 0x81 && byte <= 0xfe },
  '949': {
    label: 'euc-kr',
    opensTwoBytes: (byte) => byte >= 0x81 && byte <= 0xfe,
  },
  '950': { label: 'big5', opensTwoBytes: (byte) => byte >= 0x81 && byte <= 0xfe },
  '1258': { label: 'windows-1258' },
};

const REGISTRY_QUERY_TIMEOUT_MS = 5000;
let systemCodePageRead: Promise<ScriptOutputCodePage | undefined> | undefined;

/**
 * The code page this system's script output is read in, on native Windows
 * where the system has one supported code page for both forms. A system
 * whose ANSI and OEM code pages differ has no single reading of a
 * non-UTF-8 line, so it gets none; neither does one whose registry or
 * decoder is unavailable. Neither value changes while the system runs, so
 * the registry is asked once per process.
 */
export function readSystemCodePage(): Promise<ScriptOutputCodePage | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  systemCodePageRead ??= new Promise((resolve) => {
    const systemRoot =
      process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
    execFile(
      `${systemRoot}\\System32\\reg.exe`,
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage'],
      {
        encoding: 'latin1',
        timeout: REGISTRY_QUERY_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const registryValue = (name: string): string | undefined =>
          new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(\\d+)\\s*$`, 'm').exec(
            stdout,
          )?.[1];
        const ansi = registryValue('ACP');
        const entry =
          ansi !== undefined && ansi === registryValue('OEMCP')
            ? SCRIPT_OUTPUT_CODE_PAGES[ansi]
            : undefined;
        try {
          if (entry !== undefined) new TextDecoder(entry.label);
          resolve(entry);
        } catch {
          // A Node built without the legacy converters.
          resolve(undefined);
        }
      },
    );
  });
  return systemCodePageRead;
}

const NEWLINE = 0x0a;

/**
 * Where the line after a newline starts: past the NUL that directly
 * follows it. A UTF-16LE newline is `0A 00`, and that NUL is part of the
 * newline, not of the next line.
 */
function afterNewlineNul(bytes: Buffer, start: number): number {
  return bytes[start] === 0 ? start + 1 : start;
}

/**
 * Whether a line is read in the system code page (DR-103 §2): it is not
 * UTF-8, and it holds no NUL, which marks UTF-16 and never code-page text.
 * The one rule for a whole line and for the line a cut fell in.
 */
function readsInCodePage(validUtf8: boolean, holdsNul: boolean): boolean {
  return !validUtf8 && !holdsNul;
}

/**
 * How many bytes at the end of `bytes` open a UTF-8 character without
 * completing it: zero to three.
 */
function openUtf8Character(bytes: Buffer): number {
  for (let back = 1; back <= 3 && back <= bytes.length; back += 1) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? back : 0;
  }
  return 0;
}

/** `text` without its first character. */
function afterFirstCharacter(text: string): string {
  const first = text.codePointAt(0);
  return first === undefined ? text : text.slice(first > 0xffff ? 2 : 1);
}

/**
 * A reader of whole lines in a code page. Nothing a decoder does with
 * bytes it cannot read may fail the step: such a line stays UTF-8.
 */
function createCodePageReader(
  codePage: ScriptOutputCodePage | undefined,
): ((line: Buffer) => string) | undefined {
  if (codePage === undefined) return undefined;
  let decoder = new TextDecoder(codePage.label);
  return (line) => {
    try {
      return decoder.decode(line);
    } catch {
      decoder = new TextDecoder(codePage.label);
      return line.toString('utf8');
    }
  };
}

/**
 * The line a cut falls in (DR-103). Its dropped bytes are followed as they
 * are dropped, in UTF-8 and in the system code page, so the kept rest of
 * the line is read from a character boundary that is known — a two-byte
 * code page marks none in the bytes themselves — and the line is judged as
 * the one line it is.
 */
function createCutLine(
  codePage: ScriptOutputCodePage | undefined,
  inCodePage: ((line: Buffer) => string) | undefined,
): {
  drop(dropped: Buffer): void;
  /** The rest of that line as text, and where the whole lines begin. */
  read(kept: Buffer): { text: string; rest: number };
} {
  // UTF-8: the bytes of the character the dropped bytes leave open, and
  // whether the dropped bytes before it are valid. The first stands on its
  // own: a line that is not UTF-8 is still read from a UTF-8 boundary.
  let utf8Open: Buffer = Buffer.alloc(0);
  let utf8Valid = true;
  // Code page: whether the dropped bytes end on the first byte of a
  // two-byte character.
  let twoBytesOpen = false;
  let holdsNul = false;
  // Whether the dropped bytes end on a newline, whose NUL may follow.
  let newlineOpen = false;
  const restart = (): void => {
    utf8Valid = true;
    utf8Open = Buffer.alloc(0);
    twoBytesOpen = false;
    holdsNul = false;
  };
  // The second byte of a two-byte character is never a control, a digit,
  // or the punctuation below `@`, in any code page read here.
  const isSecondByte = (byte: number): boolean => byte >= 0x40;
  const follow = (bytes: Buffer): void => {
    if (bytes.length === 0) return;
    holdsNul ||= bytes.includes(0);
    const line = Buffer.concat([utf8Open, bytes]);
    const open = openUtf8Character(line);
    utf8Valid &&= isUtf8(line.subarray(0, line.length - open));
    utf8Open = Buffer.from(line.subarray(line.length - open));
    const opensTwoBytes = codePage?.opensTwoBytes;
    if (opensTwoBytes !== undefined) {
      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index]!;
        if (twoBytesOpen) {
          twoBytesOpen = false;
          if (isSecondByte(byte)) continue;
        }
        twoBytesOpen = opensTwoBytes(byte);
      }
    }
  };
  return {
    drop(dropped) {
      if (dropped.length === 0) return;
      let start = newlineOpen ? afterNewlineNul(dropped, 0) : 0;
      newlineOpen = false;
      // A newline ends a character in every encoding read here, so only
      // the bytes after the last one belong to the line the cut falls in.
      const newline = dropped.lastIndexOf(NEWLINE);
      if (newline >= start) {
        restart();
        start = newline + 1;
        if (start === dropped.length) {
          newlineOpen = true;
          return;
        }
        start = afterNewlineNul(dropped, start);
      }
      follow(dropped.subarray(start));
    },
    read(kept) {
      const start = newlineOpen ? afterNewlineNul(kept, 0) : 0;
      const newline = kept.indexOf(NEWLINE, start);
      const end = newline === -1 ? kept.length : newline + 1;
      const line = kept.subarray(start, end);
      // With the open character's dropped bytes restored, the kept bytes
      // read as UTF-8 exactly as the whole line would.
      const fromOpenCharacter = Buffer.concat([utf8Open, line]);
      const validUtf8 = utf8Valid && isUtf8(fromOpenCharacter);
      if (
        inCodePage !== undefined &&
        readsInCodePage(validUtf8, holdsNul || line.includes(0))
      ) {
        const second =
          twoBytesOpen && line.length > 0 && isSecondByte(line[0]!);
        return { text: inCodePage(line.subarray(second ? 1 : 0)), rest: end };
      }
      const text = fromOpenCharacter.toString('utf8');
      return {
        text: utf8Open.length === 0 ? text : afterFirstCharacter(text),
        rest: end,
      };
    },
  };
}

/**
 * Whole lines of script output as text (DR-103). UTF-8 throughout, each
 * invalid sequence becoming U+FFFD, except that a line the system code
 * page reads is read in it, where the system has one.
 */
function readWholeLines(
  bytes: Buffer,
  inCodePage: ((line: Buffer) => string) | undefined,
): string {
  if (inCodePage === undefined || isUtf8(bytes)) return bytes.toString('utf8');
  let text = '';
  for (let start = afterNewlineNul(bytes, 0); start < bytes.length; ) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline === -1 ? bytes.length : newline + 1;
    const line = bytes.subarray(start, end);
    text += readsInCodePage(isUtf8(line), line.includes(0))
      ? inCodePage(line)
      : line.toString('utf8');
    start = afterNewlineNul(bytes, end);
  }
  return text;
}

/**
 * The bounded record of what a script wrote (DR-103): the last
 * `SCRIPT_OUTPUT_TAIL_BYTES` captured bytes in arrival order, read as text
 * once. NUL goes last, so a UTF-16 line of ASCII text reads as its text and
 * no record holds U+0000.
 */
export function createScriptOutputTail(
  codePage: ScriptOutputCodePage | undefined,
): {
  push(chunk: Buffer): void;
  read(): { output: string; outputTruncated: boolean };
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const inCodePage = createCodePageReader(codePage);
  const cutLine = createCutLine(codePage, inCodePage);
  return {
    push(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      while (size > SCRIPT_OUTPUT_TAIL_BYTES) {
        const excess = size - SCRIPT_OUTPUT_TAIL_BYTES;
        const head = chunks[0]!;
        if (head.length <= excess) {
          chunks.shift();
          size -= head.length;
          cutLine.drop(head);
        } else {
          chunks[0] = head.subarray(excess);
          size -= excess;
          cutLine.drop(head.subarray(0, excess));
        }
        truncated = true;
      }
    },
    read() {
      const bytes = Buffer.concat(chunks, size);
      // Where earlier bytes were dropped, the first kept line is the rest
      // of the line the cut fell in.
      let rest = 0;
      let text = '';
      if (truncated) ({ text, rest } = cutLine.read(bytes));
      text += readWholeLines(bytes.subarray(rest), inCodePage);
      return { output: text.replace(/\0/g, ''), outputTruncated: truncated };
    },
  };
}
