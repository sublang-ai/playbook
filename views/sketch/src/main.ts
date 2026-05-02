// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import './styles.css';
import { startCodingDemo } from '../demo/coding-demo';

const canvas = document.querySelector<HTMLElement>('#sketch-canvas');
const controls = document.querySelector<HTMLElement>('#sketch-controls');

if (canvas === null || controls === null) {
  throw new Error('Missing #sketch-canvas or #sketch-controls element');
}

startCodingDemo({ canvas, controls });
