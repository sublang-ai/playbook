// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import './styles.css';

const app = document.querySelector<HTMLElement>('#app');

if (app === null) {
  throw new Error('Missing #app element');
}
