// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// DR-096: the public `@sublang/playbook/seed-config` facade. The text is
// the launcher's own seed (playbook-cli-11); this module only fixes the
// bundled template and narrows the accepted options (playbook-cli-100).

import { fileURLToPath } from 'node:url';
import { seedConfigText as seedText } from './bin/launch-config.js';

const TEMPLATE_PATH = fileURLToPath(
  new URL('./playbook.config.template.yaml', import.meta.url),
);

export function seedConfigText(options = {}) {
  const env = options.env ?? process.env;
  return seedText(
    TEMPLATE_PATH,
    env,
    ...(options.homeDir !== undefined ? [options.homeDir] : []),
  );
}
