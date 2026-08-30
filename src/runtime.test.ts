// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve files relative to this test (src/runtime.test.ts).
const sibling = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const fromRepo = (rel: string) =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));

const linkSpec = readFileSync(fromRepo('slc/link.md'), 'utf8');
const runtimeSource = readFileSync(sibling('runtime.ts'), 'utf8');
const runtimeDts = readFileSync(sibling('runtime.d.ts'), 'utf8');
const runtimeJs = readFileSync(sibling('runtime.js'), 'utf8');
const pkg = JSON.parse(readFileSync(fromRepo('package.json'), 'utf8')) as {
  files: string[];
  exports: Record<string, unknown>;
};

// The members of a result interface's `status` field.
function statusMembers(src: string, interfaceName = 'PlayerResult'): string[] {
  const m = interfaceBody(src, interfaceName).match(/status\??:\s*([^;]+);/);
  if (!m) throw new Error(`${interfaceName}.status not found`);
  return m[1]
    .split('|')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .sort();
}

// The method names declared on the `PlaybookPorts` interface.
function portsMembers(src: string): string[] {
  const names = [
    ...interfaceBody(src, 'PlaybookPorts').matchAll(/^\s*(\w+)\s*\(/gm),
  ].map((x) => x[1]);
  return [...new Set(names)].sort();
}

/** One `## <title>` section of a markdown spec, up to the next `## `. */
function sectionOf(src: string, title: string): string {
  const start = src.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`section "${title}" not found`);
  const rest = src.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

function interfaceBody(src: string, name: string): string {
  const block = src.match(
    new RegExp(
      `interface ${name}(?:\\s+extends\\s+[^\\{]+)?\\s*\\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  if (!block) throw new Error(`${name} interface not found`);
  return block[1];
}

function interfaceProperties(src: string, name: string): string[] {
  return [
    ...interfaceBody(src, name).matchAll(
      /^\s*(?:readonly\s+)?(\w+)(\??):\s*([^;]+);/gm,
    ),
  ]
    .map((match) => `${match[1]}${match[2]}:${normalizeType(match[3])}`)
    .sort();
}

function normalizeType(type: string): string {
  return type.replace(/\s+/g, '').replace(/;}/g, '}').replace(/^\|/, '');
}

function unionMembers(src: string, name: string): string[] {
  return [...typeAliasBody(src, name).matchAll(/['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .sort();
}

function typeAliasBody(src: string, name: string): string {
  const declaration = new RegExp(`(?:export\\s+)?type ${name}\\s*=`).exec(src);
  if (!declaration) throw new Error(`${name} type alias not found`);

  const start = declaration.index + declaration[0].length;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: string | undefined;

  for (let index = start; index < src.length; index += 1) {
    const character = src[index];
    const previous = src[index - 1];
    if (quote) {
      if (character === quote && previous !== '\\') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braces += 1;
    if (character === '}') braces -= 1;
    if (character === '[') brackets += 1;
    if (character === ']') brackets -= 1;
    if (character === '(') parentheses += 1;
    if (character === ')') parentheses -= 1;
    if (
      character === ';' &&
      braces === 0 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      return src.slice(start, index);
    }
  }
  throw new Error(`${name} type alias is not terminated`);
}

function callPlayerParameters(src: string): string {
  const signature = interfaceBody(src, 'PlaybookPorts').match(
    /callPlayer\s*\(([\s\S]*?)\)\s*:\s*Promise<PlayerResult>/,
  );
  if (!signature) throw new Error('PlaybookPorts.callPlayer not found');
  return normalizeType(signature[1]).replace(/,$/, '');
}

function initParameters(src: string): string {
  const signature = interfaceBody(src, 'PlaybookRuntime').match(
    /init\s*\(([\s\S]*?)\)\s*:\s*Promise<void>/,
  );
  if (!signature) throw new Error('PlaybookRuntime.init not found');
  return normalizeType(signature[1]);
}

function methodSignature(
  src: string,
  interfaceName: string,
  methodName: string,
): { parameters: string; result: string } {
  const signature = interfaceBody(src, interfaceName).match(
    new RegExp(`${methodName}\\s*\\(([\\s\\S]*?)\\)\\s*:\\s*Promise<([^>]+)>`),
  );
  if (!signature) {
    throw new Error(`${interfaceName}.${methodName} not found`);
  }
  return {
    parameters: normalizeType(signature[1]).replace(/,$/, ''),
    result: normalizeType(signature[2]),
  };
}

function syncMethodSignature(
  src: string,
  interfaceName: string,
  methodName: string,
): { parameters: string; result: string } {
  const signature = interfaceBody(src, interfaceName).match(
    new RegExp(`${methodName}\\s*\\(([\\s\\S]*?)\\)\\s*:\\s*([^;]+);`),
  );
  if (!signature) {
    throw new Error(`${interfaceName}.${methodName} not found`);
  }
  return {
    parameters: normalizeType(signature[1]).replace(/,$/, ''),
    result: normalizeType(signature[2]),
  };
}

const TRACE_TYPES = [
  'apply.finished',
  'apply.started',
  'boss.input.received',
  'boss.input.settled',
  'captain.call.finished',
  'captain.call.started',
  'fsm.transition',
  'judge.call.finished',
  'judge.call.started',
  'playbook.call.finished',
  'playbook.call.started',
  'player.call.finished',
  'player.call.started',
  'session.disposed',
  'session.started',
  'status.emitted',
];

// Markdown contract blocks may annotate members with trailing `//` comments
// that tsc's emitted declarations legitimately lack.
function stripLineComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '');
}

function applyMemberSignature(src: string): {
  parameters: string;
  result: string;
} {
  const signature = src.match(/apply\?\s*\(([\s\S]*?)\)\s*:\s*Promise<([^>]+)>/);
  if (!signature) throw new Error('optional apply member not found');
  return {
    parameters: normalizeType(signature[1]).replace(/,$/, ''),
    result: normalizeType(signature[2]),
  };
}

describe('@sublang/playbook/runtime contract module (PBRT-34/35)', () => {
  // PBRT-35: consistency with the authored slc/link.md contract.
  it('matches slc/link.md on result, resume, session, trace, and runtime shapes', () => {
    expect(statusMembers(runtimeDts)).toEqual(['aborted', 'error', 'ok']);
    expect(statusMembers(runtimeDts, 'CaptainResult')).toEqual([
      'aborted',
      'error',
      'ok',
    ]);
    expect(portsMembers(runtimeDts)).toEqual([
      'callCaptain',
      'callJudge',
      'callPlaybook',
      'callPlayer',
      'emitStatus',
      'emitTelemetry',
    ]);
    expect(statusMembers(runtimeDts)).toEqual(statusMembers(linkSpec));
    expect(statusMembers(runtimeDts, 'CaptainResult')).toEqual(
      statusMembers(linkSpec, 'CaptainResult'),
    );
    expect(portsMembers(runtimeDts)).toEqual(portsMembers(linkSpec));
    expect(interfaceProperties(runtimeDts, 'PlayerResult')).toEqual(
      interfaceProperties(linkSpec, 'PlayerResult'),
    );
    expect(interfaceProperties(runtimeDts, 'PlayerResult')).toContain(
      'resumeToken?:string',
    );
    expect(interfaceProperties(runtimeDts, 'PlayerCallOptions')).toEqual([
      'resume:string|false',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlayerCallOptions')).toEqual(
      interfaceProperties(linkSpec, 'PlayerCallOptions'),
    );
    expect(interfaceProperties(runtimeDts, 'CaptainCallOptions')).toEqual([
      'allowedTools?:readonlystring[]',
      'resume:string|false',
      "visibility:'visible'|'hidden'",
    ]);
    expect(interfaceProperties(runtimeDts, 'CaptainCallOptions')).toEqual(
      interfaceProperties(linkSpec, 'CaptainCallOptions'),
    );
    expect(interfaceProperties(runtimeDts, 'CaptainResult')).toEqual([
      'error?:string',
      'finalText?:string',
      "status:'ok'|'aborted'|'error'",
    ]);
    expect(interfaceProperties(runtimeDts, 'CaptainResult')).toEqual(
      interfaceProperties(linkSpec, 'CaptainResult'),
    );
    expect(callPlayerParameters(runtimeDts)).toBe(
      'roleId:string,prompt:string,signal:AbortSignal,options:PlayerCallOptions',
    );
    expect(callPlayerParameters(runtimeDts)).toBe(
      callPlayerParameters(linkSpec),
    );
    expect(methodSignature(runtimeDts, 'PlaybookPorts', 'callCaptain')).toEqual(
      {
        parameters:
          'prompt:string,signal:AbortSignal,options:CaptainCallOptions',
        result: 'CaptainResult',
      },
    );
    expect(methodSignature(runtimeDts, 'PlaybookPorts', 'callCaptain')).toEqual(
      methodSignature(linkSpec, 'PlaybookPorts', 'callCaptain'),
    );
    expect(
      methodSignature(runtimeDts, 'PlaybookPorts', 'callPlaybook'),
    ).toEqual({
      parameters: 'request:PlaybookCallRequest,signal:AbortSignal',
      result: 'PlaybookCallStart',
    });
    expect(
      methodSignature(runtimeDts, 'PlaybookPorts', 'callPlaybook'),
    ).toEqual(methodSignature(linkSpec, 'PlaybookPorts', 'callPlaybook'));
    expect(interfaceProperties(runtimeDts, 'NormalizedError')).toEqual([
      'message:string',
      'name:string',
      'stack?:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'NormalizedError')).toEqual(
      interfaceProperties(linkSpec, 'NormalizedError'),
    );
    expect(normalizeType(typeAliasBody(runtimeDts, 'JsonValue'))).toBe(
      normalizeType(typeAliasBody(linkSpec, 'JsonValue')),
    );
    expect(normalizeType(typeAliasBody(runtimeDts, 'PlaybookStateValue'))).toBe(
      normalizeType(typeAliasBody(linkSpec, 'PlaybookStateValue')),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookState')).toEqual([
      'activeStateIds:readonlystring[]',
      'quiescent:boolean',
      'stateId?:string',
      "status:'active'|'done'|'error'|'stopped'",
      'tags:readonlystring[]',
      'value:PlaybookStateValue',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookState')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookState'),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookPendingCall')).toEqual([
      'callId:string',
      'childSessionId:string',
      'playbookId:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookPendingCall')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookPendingCall'),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookRoleBinding')).toEqual([
      'playerId:string',
      'promptIdentity:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookRoleBinding')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookRoleBinding'),
    );
    expect(
      interfaceProperties(runtimeDts, 'PlaybookRetainedGenerationMetadata'),
    ).toEqual(['unfinishedFinalStateIds:readonlystring[]']);
    expect(
      interfaceProperties(runtimeDts, 'PlaybookRetainedGenerationMetadata'),
    ).toEqual(
      interfaceProperties(linkSpec, 'PlaybookRetainedGenerationMetadata'),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookAdoptionContext')).toEqual([
      'sourceGenerationId:string',
      'sourceSessionId:string',
      'targetChildSessionId?:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookAdoptionContext')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookAdoptionContext'),
    );
    for (const source of [runtimeDts, linkSpec]) {
      expect(interfaceBody(source, 'PlaybookRuntime')).toMatch(
        /readonly retainedGenerationMetadata\?:\s*PlaybookRetainedGenerationMetadata;/,
      );
      expect(interfaceBody(source, 'PlaybookRuntime')).toMatch(
        /adopt\?\s*\(\s*session:\s*PlaybookSession,\s*snapshot:\s*PlaybookRuntimeSnapshot,\s*context:\s*PlaybookAdoptionContext,?\s*\):\s*Promise<void>;/,
      );
    }
    expect(
      interfaceProperties(runtimeSource, 'PlaybookPendingBossQuestion'),
    ).toEqual([
      "asker:{kind:'captain'}|{kind:'role'",
      'question:string',
      'questionId:string',
      'sourceItem?:string',
    ]);
    expect(
      interfaceProperties(runtimeSource, 'PlaybookPendingBossQuestion'),
    ).toEqual(interfaceProperties(linkSpec, 'PlaybookPendingBossQuestion'));
    for (const source of [runtimeSource, linkSpec]) {
      expect(interfaceBody(source, 'PlaybookPendingBossQuestion')).toMatch(
        /asker:\s*\{\s*kind:\s*'captain';?\s*\}\s*\|\s*\{\s*kind:\s*'role';\s*roleId:\s*string;?\s*\}/,
      );
    }
    expect(runtimeDts).toMatch(
      /interface PlaybookSuspendedCall extends PlaybookPendingCall/,
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookSuspendedCall')).toEqual([
      'effectBoundaryPrefixSequence?:number|null',
      'stateId:string',
      'text:string',
      'turnId?:number',
    ]);
    expect(
      normalizeType(interfaceBody(runtimeSource, 'PlaybookRuntimeSnapshot')),
    ).toBe(
      normalizeType(interfaceBody(linkSpec, 'PlaybookRuntimeSnapshot')),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookCallRequest')).toEqual([
      'callId:string',
      'playbookId:string',
      'text:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookCallRequest')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookCallRequest'),
    );
    for (const name of ['PlaybookCallResult', 'PlaybookCallStart']) {
      expect(normalizeType(typeAliasBody(runtimeDts, name))).toBe(
        normalizeType(typeAliasBody(linkSpec, name)),
      );
    }
    expect(normalizeType(typeAliasBody(runtimeDts, 'PlaybookRunResult'))).toBe(
      normalizeType(typeAliasBody(linkSpec, 'PlaybookRunResult')),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookSession')).toEqual([
      'depth:number',
      'parentCallId?:string',
      'parentSessionId?:string',
      'playbookId:string',
      'playerSessions?:PlayerSessionStore',
      'ports:PlaybookPorts',
      'roleBindings?:Readonly<Record<string,PlaybookRoleBinding>>',
      'rootSessionId:string',
      'sessionId:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookSession')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookSession'),
    );
    const storeMethods = {
      restore: {
        parameters: 'tokens:Readonly<Record<string,string>>',
        result: 'void',
      },
      select: { parameters: 'roleId:string', result: 'string|false' },
      snapshot: {
        parameters: '',
        result: 'Readonly<Record<string,string>>',
      },
      update: {
        parameters: 'roleId:string,resumeToken?:string',
        result: 'void',
      },
    };
    for (const [method, expected] of Object.entries(storeMethods)) {
      expect(syncMethodSignature(runtimeDts, 'PlayerSessionStore', method)).toEqual(
        expected,
      );
      expect(syncMethodSignature(linkSpec, 'PlayerSessionStore', method)).toEqual(
        expected,
      );
    }
    expect(unionMembers(runtimeDts, 'PlaybookTraceType')).toEqual(TRACE_TYPES);
    expect(unionMembers(runtimeDts, 'PlaybookTraceType')).toEqual(
      unionMembers(linkSpec, 'PlaybookTraceType'),
    );
    // DR-029 / PBRT-52: the optional control-surface pair and its types.
    expect(interfaceProperties(runtimeDts, 'PlaybookControlAction')).toEqual([
      'id:string',
      'label:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookControlAction')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookControlAction'),
    );
    expect(interfaceProperties(runtimeDts, 'PlaybookControlView')).toEqual([
      'actions:readonlyPlaybookControlAction[]',
      'context?:JsonValue',
      'lastError?:NormalizedError',
      'pendingQuestions:readonlyPlaybookPendingBossQuestion[]',
      'state:PlaybookState',
      'stateDescription?:string',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookControlView')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookControlView'),
    );
    expect(
      normalizeType(typeAliasBody(runtimeDts, 'PlaybookControlReceipt')),
    ).toBe(
      normalizeType(
        stripLineComments(typeAliasBody(linkSpec, 'PlaybookControlReceipt')),
      ),
    );
    for (const src of [
      interfaceBody(runtimeDts, 'PlaybookRuntime'),
      linkSpec,
    ]) {
      expect(src).toMatch(/describe\?\s*\(\s*\)\s*:\s*PlaybookControlView;/);
      expect(applyMemberSignature(src)).toEqual({
        parameters: 'input:{actionId:string;key:string;signal:AbortSignal}',
        result: 'PlaybookControlReceipt',
      });
    }
    expect(interfaceProperties(runtimeDts, 'PlaybookTraceEvent')).toEqual([
      'callId?:string',
      'depth:number',
      'parentCallId?:string',
      'parentSessionId?:string',
      'payload:JsonValue',
      'playbookId:string',
      'rootSessionId:string',
      'schemaVersion:3',
      'sequence:number',
      'sessionId:string',
      'timestamp:number',
      'turnId?:number',
      'type:PlaybookTraceType',
    ]);
    expect(interfaceProperties(runtimeDts, 'PlaybookTraceEvent')).toEqual(
      interfaceProperties(linkSpec, 'PlaybookTraceEvent'),
    );
    expect(initParameters(runtimeDts)).toBe('session:PlaybookSession');
    expect(initParameters(runtimeDts)).toBe(initParameters(linkSpec));
    expect(
      methodSignature(runtimeDts, 'PlaybookRuntime', 'handleBossInput'),
    ).toEqual({
      parameters: 'turn:{text:string;signal:AbortSignal}',
      result: 'PlaybookRunResult',
    });
    expect(
      methodSignature(runtimeDts, 'PlaybookRuntime', 'handleBossInput'),
    ).toEqual(methodSignature(linkSpec, 'PlaybookRuntime', 'handleBossInput'));
    expect(
      methodSignature(runtimeDts, 'PlaybookRuntime', 'resumePlaybookCall'),
    ).toEqual({
      parameters:
        'input:{callId:string;result:PlaybookCallResult;signal:AbortSignal}',
      result: 'PlaybookRunResult',
    });
    expect(
      methodSignature(runtimeDts, 'PlaybookRuntime', 'resumePlaybookCall'),
    ).toEqual(
      methodSignature(linkSpec, 'PlaybookRuntime', 'resumePlaybookCall'),
    );
  });

  it('keeps unresolved-effect state-only and stateDescription terminal-only', () => {
    for (const source of [runtimeSource, runtimeDts, linkSpec]) {
      const result = typeAliasBody(source, 'PlaybookRunResult');
      const terminal = result.match(
        /\{[^{}]*outcome:\s*'terminal';[^{}]*\}/,
      )?.[0];
      expect(terminal).toBeDefined();
      expect(terminal).toMatch(/stateDescription\?:\s*string;/);
      expect(result.replace(terminal!, '')).not.toMatch(
        /stateDescription\??:/,
      );
      const unresolvedEffect = result.match(
        /\{[^{}]*outcome:\s*'unresolved-effect';[^{}]*\}/,
      )?.[0];
      expect(unresolvedEffect).toBeDefined();
      expect(normalizeType(unresolvedEffect!)).toBe(
        "{outcome:'unresolved-effect';state:PlaybookState}",
      );
      expect(unresolvedEffect).not.toMatch(
        /stateDescription|output|pendingCall|error|effectLedger|receipt|unresolvedEffects|semanticCandidate/,
      );
    }
  });

  it('keeps the unresolved-effect envelope seam optional and identity-only', () => {
    const expected =
      "unresolvedEffectEnvelopes?():readonly({readonlykind:'boundary';readonlyboundaryId:string}|{readonlykind:'logical-operation';readonlyoperationId:string})[];";
    for (const source of [runtimeSource, runtimeDts, linkSpec]) {
      const runtime = normalizeType(interfaceBody(source, 'PlaybookRuntime'));
      const signature = runtime
        .match(/unresolvedEffectEnvelopes\?\(\):readonly\([\s\S]*?\)\[\];/)?.[0]
        .replace('readonly(|', 'readonly(');
      expect(signature).toBe(expected);
      expect(signature).not.toMatch(
        /receipt|projection|repository|observation|evidence|authority/,
      );
    }
  });

  // The linker contract is the source the artifacts are generated from, so a
  // rule that lives only in the shipped artifacts is a rule the next re-link
  // can undo. These assert the two clauses the ControlView privacy contract
  // rests on are stated where a linker would read them — matching type shapes
  // alone would not: the old text declared the same `context?: JsonValue`
  // while describing an allow-by-default serialization of the FSM context.
  it('states the authored context projection in the linker contract', () => {
    const controlSurface = sectionOf(linkSpec, 'Control surface (optional)');
    // The rule itself, and the spec member a linked module carries it in.
    expect(controlSurface).toMatch(
      /explicit projection the linked runtime \*\*authors\*\*/,
    );
    expect(controlSurface).toContain('controlContextFields');
    expect(controlSurface).toMatch(/naming no member carries no `context`/);
    // And the retired behavior is gone, not merely contradicted elsewhere.
    expect(controlSurface).not.toMatch(
      /sanitized\s+JSON-safe relevant FSM context/,
    );
  });

  it('lists the context projection among the emitted spec members', () => {
    const output = sectionOf(linkSpec, 'Output');
    // §Output's enumeration is closed ("only what the factory cannot read"),
    // so a member missing from it is a member a conforming linker omits — and
    // omitting this one produces an artifact that exposes no context at all.
    // The assertion is scoped to the enumeration itself: the paragraph that
    // explains the member sits in the same section, so a section-wide match
    // would stay green with the member dropped from the list it belongs to.
    const enumeration = /Supplies in `spec` only what the factory cannot read[\s\S]*?\.\n/.exec(
      output,
    )?.[0];
    expect(enumeration).toBeDefined();
    expect(enumeration).toContain('controlContextFields');
    expect(output).toMatch(/default is\s+\*nothing\* rather than everything/);
    // The composer clause matches what a controller artifact can carry: the
    // composers its own machine uses, not a fixed pair.
    expect(output).toMatch(/at least the prompt composers its own machine uses/);
    expect(output).not.toMatch(
      /at least the player-prompt and Captain-prompt composers/,
    );
  });

  it('requires link-time unfinished-final metadata in emitted artifacts', () => {
    const output = sectionOf(linkSpec, 'Output');
    const enumeration = /Supplies in `spec` only what the factory cannot read[\s\S]*?\.\n/.exec(
      output,
    )?.[0];
    expect(enumeration).toBeDefined();
    expect(enumeration).toContain('unfinishedFinalStateIds');
    expect(output).toMatch(/mechanical link-time metadata/);
    expect(output).toMatch(/explicitly empty when no terminal outcome does/);
    expect(output).toMatch(
      /reject a declared id that does not name a root final state/,
    );
    expect(output).toMatch(/reject it at construction before runtime effects/);
    expect(output).toMatch(
      /artifact declaration is not itself the public runtime retention marker or an adoption capability/,
    );
    const classification = sectionOf(
      linkSpec,
      'Retained-generation classification (optional)',
    );
    expect(classification).toContain('retainedGenerationMetadata');
    expect(classification).toMatch(/explicitly empty/);
    expect(classification).toMatch(
      /presence supplies only\s+terminal classification metadata\s+and does not itself supply the adoption operation/,
    );
    expect(classification).toMatch(
      /parked-session snapshot pair and the independently feature-detected\s+adoption capability so a Captain can retain/,
    );
    expect(classification).toMatch(/opts into classification only/);
    expect(classification).toContain('createXStatePlaybookRuntime');
    const adoption = sectionOf(linkSpec, 'Retained-snapshot adoption (optional)');
    expect(adoption).toContain('adopt(session, snapshot, context)');
    expect(adoption).toMatch(
      /Every runtime the shared `createXStatePlaybookRuntime` factory\s+constructs implements `adopt`/,
    );
    expect(adoption).toMatch(/fresh valid `PlaybookSession`\s+identity/);
    expect(adoption).toMatch(/before calling the\s+runtime capability/);
    expect(adoption).toMatch(
      /exact closed-schema `PlaybookAdoptionContext` whose nonempty\s+`sourceSessionId` names the retained frame's source runtime session/,
    );
    expect(adoption).toMatch(
      /consumes `playbook-1` as the fresh target call id/,
    );
    expect(adoption).toMatch(
      /emit exactly\s+one `session\.started` as target trace sequence `1`/,
    );
    expect(adoption).toMatch(
      /same-engagement restore remains trace-silent and preserves its source\s+identities and counters exactly/,
    );
    expect(adoption).toMatch(
      /shall not apply the retained snapshot's `roleResumeTokens` through a\s+supplied player-session store's `restore` operation or seed runtime-private\s+continuation from them/,
    );
    expect(adoption).toMatch(
      /target\s+session `roleBindings` are the sole source of supplied player and prompt\s+identities, and any supplied player-session store is the sole conversation\s+authority/,
    );
    expect(adoption).toMatch(
      /resolve the current binding and, when a store is\s+supplied, select it at the invocation boundary and pass the exact selected\s+token or `false`/,
    );
    expect(adoption).toMatch(
      /ordinary\s+continuation rules authorize a store mutation, that mutation\s+shall target the same store/,
    );
    expect(adoption).toMatch(
      /never fall back to the retained token\s+projection/,
    );
    expect(adoption).toMatch(
      /replacement binding whose current selection is `false`\s+therefore\s+starts fresh under its new identities/,
    );
  });

  // PBRT-34/35: every authored contract type is exported.
  it('exports every shared contract type', () => {
    for (const name of [
      'PlayerResult',
      'PlayerCallOptions',
      'PlaybookRoleBinding',
      'PlayerSessionStore',
      'CaptainResult',
      'CaptainCallOptions',
      'NormalizedError',
      'PlaybookState',
      'PlaybookPendingCall',
      'PlaybookSuspendedCall',
      'PlaybookCallRequest',
      'PlaybookControlAction',
      'PlaybookControlView',
      'PlaybookPorts',
      'PlaybookSession',
      'PlaybookAdoptionContext',
      'PlaybookTraceEvent',
      'PlaybookRuntimeSnapshot',
      'PlaybookRetainedGenerationMetadata',
      'PlaybookRuntime',
    ]) {
      expect(runtimeDts).toMatch(new RegExp(`export interface ${name}\\b`));
    }
    for (const name of [
      'JsonValue',
      'PlaybookStateValue',
      'PlaybookCallResult',
      'PlaybookCallStart',
      'PlaybookRunResult',
      'PlaybookControlReceipt',
      'PlaybookTraceType',
      'PlaybookRuntimeFactory',
    ]) {
      expect(runtimeDts).toMatch(new RegExp(`export type ${name}\\b`));
    }
  });

  // PBRT-34/35: the module imports nothing at all, which strictly
  // implies it reaches no CODE or FSM type, directly or transitively.
  // (Substring matching on names like `code.playbook` is avoided: the
  // header comment legitimately mentions them as prose.)
  it('is standalone: imports no module, so reaches no CODE or FSM type', () => {
    for (const src of [runtimeSource, runtimeDts, runtimeJs]) {
      expect(src).not.toMatch(/\bfrom\s+['"]/); // `... from '...'`
      expect(src).not.toMatch(/^\s*import\s+['"]/m); // side-effect import
      expect(src).not.toMatch(/\bimport\s*\(/); // dynamic import()
      expect(src).not.toMatch(/\brequire\s*\(/); // require()
    }
    expect(runtimeSource).not.toMatch(
      /^\s*(?:export\s+)?(?:const|let|var|function|class)\b/m,
    );
  });

  // RELEASE-15: a downstream consumer's `./runtime` import resolves to
  // committed type + value artifacts listed in `files`.
  it('is wired as a public ./runtime export over committed artifacts', () => {
    expect(pkg.exports['./runtime']).toEqual({
      types: './src/runtime.d.ts',
      default: './src/runtime.js',
    });
    expect(pkg.files).toContain('src/runtime.js');
    expect(pkg.files).toContain('src/runtime.d.ts');
    expect(existsSync(sibling('runtime.d.ts'))).toBe(true);
    expect(existsSync(sibling('runtime.js'))).toBe(true);
  });

  // The default artifact is a valid, loadable ESM module.
  it('ships a valid, loadable ESM module', async () => {
    const mod = await import(new URL('runtime.js', import.meta.url).href);
    expect(typeof mod).toBe('object');
  });
});
