// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
export function parseRegisteredCommand(prompt) {
    const match = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(prompt.trim());
    if (!match)
        return undefined;
    return { command: match[1], text: (match[2] ?? '').trim() };
}
