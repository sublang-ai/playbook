// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-046: the public `@sublang/playbook/host-capabilities` facade. Every
// member is the CLI host's own repository-effect implementation; this module
// only narrows the accepted arguments to the declared surface.

import {
  REPOSITORY_RECEIPT_CLASSIFICATIONS,
  captureRepositoryReceipt as capture,
  classifyRepositoryReceipt as classify,
  createFailClosedHostCapabilities,
  createWorktreeHostCapabilities,
  observeGitRepository as observe,
} from './bin/repository-effects.js';

export {
  REPOSITORY_RECEIPT_CLASSIFICATIONS,
  createFailClosedHostCapabilities,
  createWorktreeHostCapabilities,
};

export async function observeGitRepository(cwd) {
  return observe(cwd);
}

export async function classifyRepositoryReceipt(baseline, after, options) {
  return classify(baseline, after, receiptOptions(options));
}

export async function captureRepositoryReceipt(baseline, options) {
  return capture(baseline, receiptOptions(options));
}

function receiptOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('repository receipt options must be an object');
  }
  return { allowedDispositions: options.allowedDispositions };
}
