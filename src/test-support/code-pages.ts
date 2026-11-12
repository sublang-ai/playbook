// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Test-only: the Windows code pages script output is read in (DR-103). Each
// sample is a text and one character with their bytes in that code page, as
// octal escapes, so a command's own text never spells them. Every byte of
// every `char` lies in 0x80–0xBF, which UTF-8 reads as the continuation of a
// character.

import { execFileSync } from 'node:child_process';

export interface CodePageSample {
  text: string;
  bytes: string;
  char: string;
  charBytes: string;
  charWidth: 1 | 2;
}
export const CODE_PAGE_SAMPLES: Record<string, CodePageSample> = {
  '874': {
    text: 'ไม่พบไฟล์ที่ระบุ',
    bytes: String.raw`\344\301\350\276\272\344\277\305\354\267\325\350\303\320\272\330`,
    char: 'ก',
    charBytes: String.raw`\241`,
    charWidth: 1,
  },
  '932': {
    text: '指定されたパスが見つかりません。',
    bytes: String.raw`\216\167\222\350\202\263\202\352\202\275\203\160\203\130\202\252\214\251\202\302\202\251\202\350\202\334\202\271\202\361\201\102`,
    char: 'あ',
    charBytes: String.raw`\202\240`,
    charWidth: 2,
  },
  '936': {
    text: '系统找不到指定的文件。',
    bytes: String.raw`\317\265\315\263\325\322\262\273\265\275\326\270\266\250\265\304\316\304\274\376\241\243`,
    char: '啊',
    charBytes: String.raw`\260\241`,
    charWidth: 2,
  },
  '949': {
    text: '지정된 경로를 찾을 수 없습니다.',
    bytes: String.raw`\301\366\301\244\265\310\040\260\346\267\316\270\246\040\303\243\300\273\040\274\366\040\276\370\275\300\264\317\264\331\056`,
    char: '가',
    charBytes: String.raw`\260\241`,
    charWidth: 2,
  },
  '950': {
    text: '系統找不到指定的路徑。',
    bytes: String.raw`\250\164\262\316\247\344\244\243\250\354\253\374\251\167\252\272\270\364\256\174\241\103`,
    char: '中',
    charBytes: String.raw`\244\244`,
    charWidth: 2,
  },
  '1258': {
    text: 'Không tìm thấy tệp',
    bytes: String.raw`\113\150\364\156\147\040\164\151\314\155\040\164\150\342\354\171\040\164\352\362\160`,
    char: '°',
    charBytes: String.raw`\260`,
    charWidth: 1,
  },
};

/** The bytes a run of octal escapes names. */
export function octalBytes(escapes: string): Buffer {
  return Buffer.from(
    escapes
      .split('\\')
      .slice(1)
      .map((digits) => Number.parseInt(digits, 8)),
  );
}

let systemCodePage: { page: string | undefined } | undefined;

/**
 * The one code page a native Windows system locale has for both its ANSI
 * and its OEM form, read through PowerShell rather than the registry value
 * the runtime reads. None where the two differ, and none off Windows.
 */
export function windowsSystemCodePage(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  if (systemCodePage === undefined) {
    const [ansi, oem] = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$t = (Get-WinSystemLocale).TextInfo; "$($t.ANSICodePage) $($t.OEMCodePage)"',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
      .trim()
      .split(' ');
    systemCodePage = { page: ansi === oem ? ansi : undefined };
  }
  return systemCodePage.page;
}
