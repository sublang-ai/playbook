<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PBCODE: playbook-code CLI

## Intent

This spec defines the user-facing behavior of the `playbook-code`
command shipped by the `@sublang/playbook` npm package.

## Command

### PBCODE-1

Where `@sublang/playbook` is installed globally, the package
shall expose a `playbook-code` executable; running it shall start
the reference CODE playbook and forward every command-line
argument verbatim to it, with stdin, stdout, and stderr inherited
from the caller.

### PBCODE-2

When the CODE playbook process exits, `playbook-code` shall exit
with the same status code, or re-raise the same signal on itself
if that process was terminated by a signal; when it cannot launch
the playbook at all, it shall print a diagnostic to stderr and
exit with code 127.
