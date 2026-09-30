// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-075: the public `@sublang/playbook/machine-identity` facade. Every
// member is the CLI host's own identity implementation; this module only
// narrows the accepted arguments to the declared surface (playbook-cli-95).

import {
  MACHINE_IDENTITY_TAG_PREFIX,
  isMachineIdentity,
  machineIdentityPath,
  resolveMachineIdentity as resolve,
} from './bin/machine-identity.js';

export { MACHINE_IDENTITY_TAG_PREFIX, isMachineIdentity, machineIdentityPath };

export function resolveMachineIdentity(options = {}) {
  return resolve({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.homeDir !== undefined ? { homeDir: options.homeDir } : {}),
  });
}
