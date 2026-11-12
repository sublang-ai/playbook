// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The script-output tail read directly (DR-103), so its decoding and its
// cut tracking run on every platform and in every code page. The real pipe
// and a real Windows code page are `script-output.integration.test.ts`'s.

import { isUtf8 } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  createScriptOutputTail,
  SCRIPT_OUTPUT_CODE_PAGES,
  SCRIPT_OUTPUT_TAIL_BYTES,
  type ScriptOutputCodePage,
} from './script-output.js';
import { CODE_PAGE_SAMPLES, octalBytes } from './test-support/code-pages.ts';

const LIMIT = SCRIPT_OUTPUT_TAIL_BYTES;
const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');
const repeat = (bytes: Buffer, count: number): Buffer =>
  Buffer.alloc(bytes.length * count, bytes);
// A UTF-16LE line as `wsl.exe` prints one: its newline is `0A 00`.
const utf16Line = (text: string): Buffer => Buffer.from(`${text}\n`, 'utf16le');

// What the tail records for `bytes`, however they arrive.
const CHUNK_SIZES = [Number.MAX_SAFE_INTEGER, 4096, 7, 1];
function read(
  codePage: ScriptOutputCodePage | undefined,
  bytes: Buffer,
  chunkSize: number,
): { output: string; outputTruncated: boolean } {
  const tail = createScriptOutputTail(codePage);
  for (let at = 0; at < bytes.length; at += chunkSize) {
    tail.push(bytes.subarray(at, at + chunkSize));
  }
  return tail.read();
}
// One comparison of the whole text, so a failure names the case and not
// 16 KiB of it.
function expectRecord(
  codePage: ScriptOutputCodePage | undefined,
  bytes: Buffer,
  output: string,
  outputTruncated: boolean,
): void {
  for (const chunkSize of CHUNK_SIZES) {
    const record = read(codePage, bytes, chunkSize);
    expect(record.outputTruncated).toBe(outputTruncated);
    expect(record.output.normalize('NFC') === output.normalize('NFC')).toBe(
      true,
    );
  }
}

describe('script output with no code page (DR-103)', () => {
  it('reads lenient UTF-8 and removes NUL', () => {
    expectRecord(
      undefined,
      Buffer.concat([
        Buffer.from([0x6f, 0x6b, 0x20, 0xff, 0xfe, 0x20, 0x62, 0x61, 0x64, 0x0a]),
        utf16Line('WSL'),
      ]),
      'ok \uFFFD\uFFFD bad\nWSL\n',
      false,
    );
  });

  it('keeps exactly the bound, and reports the first byte beyond it', () => {
    expectRecord(undefined, repeat(utf8('x'), LIMIT), 'x'.repeat(LIMIT), false);
    expectRecord(
      undefined,
      Buffer.concat([utf8('y'), repeat(utf8('x'), LIMIT)]),
      'x'.repeat(LIMIT),
      true,
    );
  });

  it('drops the character a cut split', () => {
    // The kept bytes open on the last byte of a three-byte character.
    expectRecord(
      undefined,
      Buffer.concat([repeat(utf8('中'), 6000), utf8('ab\n')]),
      `${'中'.repeat(5460)}ab\n`,
      true,
    );
  });

  it('drops it after bytes that are not UTF-8, leaving no U+FFFD', () => {
    expectRecord(
      undefined,
      Buffer.concat([Buffer.from([0xff]), repeat(utf8('中'), 6000)]),
      '中'.repeat(5461),
      true,
    );
  });
});

describe.each(Object.keys(SCRIPT_OUTPUT_CODE_PAGES))(
  'script output read in code page %s (DR-103)',
  (page) => {
    const codePage = SCRIPT_OUTPUT_CODE_PAGES[page]!;
    const sample = CODE_PAGE_SAMPLES[page]!;
    const line = Buffer.concat([octalBytes(sample.bytes), utf8('\n')]);
    const char = octalBytes(sample.charBytes);
    const width = sample.charWidth;
    const lead = repeat(utf8('x'), 100);

    it('reads a line that is not UTF-8 in the code page, beside UTF-8 and UTF-16 lines', () => {
      // U+9519 then `A` in UTF-16LE, whose NUL marks it as no code-page text.
      expectRecord(
        codePage,
        Buffer.concat([utf8('中文 ok\n'), line, utf16Line('\u9519A')]),
        `中文 ok\n${sample.text}\n\u0019\uFFFDA\n`,
        false,
      );
    });

    it('keeps a cut code-page line intact where the cut falls between two characters', () => {
      const kept = LIMIT / width;
      expectRecord(
        codePage,
        Buffer.concat([lead, repeat(char, kept)]),
        sample.char.repeat(kept),
        true,
      );
    });

    it('drops only the partial character where the cut falls inside one', () => {
      expectRecord(
        codePage,
        Buffer.concat([lead, repeat(char, LIMIT / width + 1), utf8('\n')]),
        `${sample.char.repeat(Math.floor((LIMIT - 1) / width))}\n`,
        true,
      );
    });

    it('keeps a cut code-page line aligned where ASCII follows it', () => {
      expectRecord(
        codePage,
        Buffer.concat([lead, repeat(char, LIMIT / width), utf8('ok\n')]),
        `${sample.char.repeat(Math.floor((LIMIT - 3) / width))}ok\n`,
        true,
      );
    });

    it('keeps a whole code-page character that opens the kept tail', () => {
      const ascii = LIMIT - width - 1;
      expectRecord(
        codePage,
        Buffer.concat([lead, char, utf8('\n'), repeat(utf8('a'), ascii)]),
        `${sample.char}\n${'a'.repeat(ascii)}`,
        true,
      );
    });

    it('drops the partial character of a cut UTF-8 line before a code-page line', () => {
      const whole = Math.floor((LIMIT - line.length - 3) / 3);
      expectRecord(
        codePage,
        Buffer.concat([
          repeat(utf8('x'), 5000),
          repeat(utf8('中'), 6000),
          utf8('ab\n'),
          line,
        ]),
        `${'中'.repeat(whole)}ab\n${sample.text}\n`,
        true,
      );
    });

    it('reads random mixes of lines as the characters they were built from', () => {
      // A deterministic generator: each line is a list of characters whose
      // bytes and width are known, so where a cut may fall is known too.
      let seed = (Number(page) * 2654435761) >>> 0 || 1;
      const random = (): number => {
        seed ^= seed << 13;
        seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        seed >>>= 0;
        return seed / 0x100000000;
      };
      const int = (low: number, high: number): number =>
        low + Math.floor(random() * (high - low + 1));
      const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
      const range = (ranges: readonly (readonly [number, number])[]): number => {
        const [low, high] = pick(ranges);
        return int(low, high);
      };
      const asciiChar = (): Buffer =>
        Buffer.from([pick([0x20, 0x2e, 0x30, 0x3a, 0x41, 0x61, 0x6f, 0x6b, 0x7a, 0x5c])]);
      const utf8Char = (): Buffer =>
        utf8(pick(['é', 'ß', '中', '文', '路', '€', '😀', '𝒳', 'я', '·', '×']));
      // Characters of each code page, some with a second byte in the ASCII
      // range, which no UTF-8 reading tells from a character of its own.
      const codePageChar: Record<string, () => Buffer> = {
        '874': () => Buffer.from([int(0xa1, 0xda)]),
        '932': () =>
          random() < 0.2
            ? Buffer.from([int(0xa1, 0xdf)])
            : random() < 0.3
              ? Buffer.from([0x82, int(0x9f, 0xf1)])
              : Buffer.from([int(0x88, 0x9f), range([[0x40, 0x7e], [0x80, 0xfc]])]),
        '936': () =>
          random() < 0.8
            ? Buffer.from([int(0xb0, 0xf7), int(0xa1, 0xfe)])
            : random() < 0.5
              ? Buffer.from([int(0xa1, 0xa9), int(0xa1, 0xfe)])
              : Buffer.from([int(0x81, 0xa0), int(0x40, 0x7e)]),
        '949': () => Buffer.from([int(0xb0, 0xc8), int(0xa1, 0xfe)]),
        '950': () =>
          Buffer.from([int(0xa4, 0xc5), range([[0x40, 0x7e], [0xa1, 0xfe]])]),
        '1258': () => Buffer.from([pick([0xa9, 0xab, 0xb0, 0xc0, 0xe0, 0xf4])]),
      };
      const decoder = new TextDecoder(codePage.label);
      const kinds = [
        'ascii',
        'utf8',
        'code-page',
        'code-page',
        'mixed-utf8',
        'mixed-code-page',
      ] as const;
      const makeLine = (): Buffer[] => {
        const kind = pick(kinds);
        const length = pick([0, 1, 2, 3, 5, 20, 80, 300, 2000, 9000, 20000]);
        const units: Buffer[] = [];
        for (let index = 0; index < length; index += 1) {
          if (kind === 'ascii') units.push(asciiChar());
          else if (kind === 'utf8') units.push(utf8Char());
          else if (kind === 'code-page') units.push(codePageChar[page]!());
          else if (kind === 'mixed-utf8') {
            units.push(random() < 0.5 ? asciiChar() : utf8Char());
          } else units.push(random() < 0.5 ? asciiChar() : codePageChar[page]!());
        }
        return units;
      };
      const text = (bytes: Buffer): string =>
        isUtf8(bytes) ? bytes.toString('utf8') : decoder.decode(bytes);

      for (let iteration = 0; iteration < 120; iteration += 1) {
        const lines = Array.from({ length: int(1, 6) }, makeLine);
        const endsWithNewline = random() < 0.7;
        const lineBytes = lines.map((units, index) =>
          Buffer.concat([
            ...units,
            index < lines.length - 1 || endsWithNewline
              ? utf8('\n')
              : Buffer.alloc(0),
          ]),
        );
        const all = Buffer.concat(lineBytes);
        const cut = Math.max(0, all.length - LIMIT);

        // The expected text, from the boundaries the generator knows.
        let expected = '';
        let offset = 0;
        lines.forEach((units, index) => {
          const bytes = lineBytes[index]!;
          const lineStart = offset;
          offset += bytes.length;
          if (offset <= cut) return;
          if (lineStart >= cut) {
            expected += text(bytes);
            return;
          }
          // The cut falls in this line: it is read from the first character
          // boundary at or after the cut, in the encoding of the whole line.
          if (isUtf8(bytes)) {
            let boundary = cut - lineStart;
            while (
              boundary < bytes.length &&
              (bytes[boundary]! & 0xc0) === 0x80
            ) {
              boundary += 1;
            }
            expected += text(bytes.subarray(boundary));
            return;
          }
          let boundary = 0;
          for (const unit of units) {
            if (lineStart + boundary >= cut) break;
            boundary += unit.length;
          }
          // Past every character, the newline is a boundary of its own.
          if (lineStart + boundary < cut) boundary = bytes.length;
          expected += decoder.decode(bytes.subarray(boundary));
        });

        const tail = createScriptOutputTail(codePage);
        for (let at = 0; at < all.length; ) {
          const size = pick([1, 2, 3, 7, 64, 1000, 4096, 16384, 65536]);
          tail.push(all.subarray(at, at + size));
          at += size;
        }
        const { output, outputTruncated } = tail.read();
        expect(outputTruncated).toBe(cut > 0);
        if (output !== expected) {
          // Name the first difference, not two 16 KiB texts.
          let at = 0;
          while (at < output.length && output[at] === expected[at]) at += 1;
          expect({
            iteration,
            at,
            got: output.slice(Math.max(0, at - 3), at + 12),
          }).toEqual({
            iteration,
            at,
            got: expected.slice(Math.max(0, at - 3), at + 12),
          });
        }
      }
    });
  },
);
