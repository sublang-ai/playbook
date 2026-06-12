// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import createPlaybookCaptainShell from './playbook-captain.js';
export { codePlaybookRegistryEntry, createCodeRuntimeOptions, validateCodeOptions, } from './code.registry.js';
// Compatibility shim for the historic `./code/tmux-play` package
// export. Public launch paths now target the Playbook Captain shell
// directly; explicit configs that still import this module get the
// same shell with CODE registered.
export default function createCodeTmuxPlayCaptain(options) {
    return createPlaybookCaptainShell(options);
}
