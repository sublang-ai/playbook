// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
//
// Public runtime contract for @sublang/playbook — the type-only single
// source for the PlaybookPorts / PlaybookRuntime contract authored in
// slc/link.md. It imports no CODE or FSM types, so the dependency runs
// one way: linked playbook runtimes (e.g. code.playbook.ts) import and
// re-export these names rather than redefining them
// (PBRT-5, PBRT-34, DR-004 Addendum A4).
// DR-063 §1: the closed list of failure codes. There is no unknown code — an
// unrecognized failure is `runtime-defect` carrying its message as `reason` —
// so a host catalogue is complete exactly when it covers this list.
export const PLAYBOOK_FAILURE_CODES = [
    'commit-missing',
    'commit-residual',
    'pre-existing-lost',
    'commits-more-than-one',
    'history-rewritten',
    'foreign-change',
    'observation-unstable',
    'attribution-ambiguous',
    'receipt-missing',
    'judge-failed',
    'player-failed',
    'aborted',
    'child-failed',
    'runtime-defect',
];
/** Evidence members admitted for each code, in the order a sentence reads them. */
const FAILURE_EVIDENCE_MEMBERS = {
    'commit-missing': {
        required: ['required', 'observed', 'baselineHead', 'afterHead', 'paths'],
        optional: [],
        paths: ['uncommitted'],
    },
    'commit-residual': {
        required: ['required', 'observed', 'baselineHead', 'afterHead', 'paths'],
        optional: ['commitOid'],
        paths: ['uncommitted', 'altered'],
    },
    'pre-existing-lost': {
        required: ['required', 'observed', 'baselineHead', 'paths'],
        optional: ['afterHead'],
        paths: ['lost'],
    },
    'commits-more-than-one': {
        required: ['required', 'observed', 'baselineHead', 'afterHead'],
        optional: [],
        paths: [],
    },
    'history-rewritten': {
        required: ['required', 'observed', 'baselineHead', 'afterHead'],
        optional: [],
        paths: [],
    },
    'foreign-change': {
        required: ['required', 'observed', 'baselineHead', 'afterHead', 'paths'],
        optional: [],
        paths: ['changed'],
    },
    'observation-unstable': {
        required: ['required', 'observed', 'baselineHead'],
        optional: [],
        paths: [],
    },
    'attribution-ambiguous': {
        required: ['required', 'observed', 'baselineHead'],
        optional: ['afterHead'],
        paths: [],
    },
    'receipt-missing': { required: ['baselineHead'], optional: [], paths: [] },
    'judge-failed': { required: ['reason'], optional: ['error'], paths: [] },
    'player-failed': {
        required: ['roleId', 'error'],
        optional: ['playerId', 'errorCode'],
        paths: [],
    },
    aborted: { required: [], optional: [], paths: [] },
    'child-failed': { required: ['playbookId'], optional: ['cause'], paths: [] },
    'runtime-defect': { required: ['reason'], optional: [], paths: [] },
};
const FAILURE_PATH_LIMIT = 32;
const FAILURE_CAUSE_DEPTH_LIMIT = 4;
const REPOSITORY_DISPOSITIONS = [
    'unchanged',
    'one-descendant-commit',
    'deferred',
];
const RECEIPT_CLASSIFICATIONS = [
    'unchanged',
    'one-descendant-commit',
    'multiple-commits',
    'rewritten-or-non-descendant',
    'worktree-only-change',
    'concurrent-or-foreign-change',
    'observation-ambiguous',
];
function failureCauseRecord(value, path) {
    if (value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null)) {
        throw new TypeError(`${path} must be a plain object`);
    }
    return value;
}
function failureCauseString(value, path) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${path} must be a nonempty string`);
    }
    return value;
}
function failureCausePathList(value, path) {
    if (!Array.isArray(value))
        throw new TypeError(`${path} must be an array`);
    if (value.length > FAILURE_PATH_LIMIT) {
        throw new TypeError(`${path} must hold at most ${FAILURE_PATH_LIMIT} paths`);
    }
    const paths = value.map((entry, index) => failureCauseString(entry, `${path}[${index}]`));
    for (const [index, entry] of paths.entries()) {
        if (index > 0 && !(paths[index - 1] < entry)) {
            throw new TypeError(`${path} must be sorted and free of duplicates`);
        }
    }
    return Object.freeze(paths);
}
function failureCausePaths(value, admitted, path) {
    const record = failureCauseRecord(value, path);
    const allowed = new Set([...admitted, 'truncated']);
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
            throw new TypeError(`${path} must not carry ${JSON.stringify(key)}`);
        }
    }
    const paths = {};
    for (const member of admitted) {
        if (!Object.hasOwn(record, member)) {
            throw new TypeError(`${path}.${member} is required`);
        }
        paths[member] = failureCausePathList(record[member], `${path}.${member}`);
    }
    if (Object.hasOwn(record, 'truncated')) {
        const truncated = record.truncated;
        if (typeof truncated !== 'number' ||
            !Number.isSafeInteger(truncated) ||
            truncated <= 0) {
            throw new TypeError(`${path}.truncated must be a positive integer`);
        }
        paths.truncated = truncated;
    }
    return Object.freeze(paths);
}
function failureCauseErrorEvidence(value, path) {
    const record = failureCauseRecord(value, path);
    for (const key of Object.keys(record)) {
        if (key !== 'name' && key !== 'message') {
            throw new TypeError(`${path} must not carry ${JSON.stringify(key)}`);
        }
    }
    if (typeof record.message !== 'string') {
        throw new TypeError(`${path}.message must be a string`);
    }
    return Object.freeze({
        name: failureCauseString(record.name, `${path}.name`),
        message: record.message,
    });
}
function validateFailureCause(value, path, depth) {
    if (depth > FAILURE_CAUSE_DEPTH_LIMIT) {
        throw new TypeError(`${path} must nest at most ${FAILURE_CAUSE_DEPTH_LIMIT} causes`);
    }
    const record = failureCauseRecord(value, path);
    for (const key of Object.keys(record)) {
        if (key !== 'code' && key !== 'evidence') {
            throw new TypeError(`${path} must not carry ${JSON.stringify(key)}`);
        }
    }
    const code = record.code;
    if (typeof code !== 'string' ||
        !PLAYBOOK_FAILURE_CODES.includes(code)) {
        throw new TypeError(`${path}.code must be one of the declared codes`);
    }
    const spec = FAILURE_EVIDENCE_MEMBERS[code];
    const evidenceRecord = failureCauseRecord(record.evidence, `${path}.evidence`);
    const allowed = new Set([...spec.required, ...spec.optional]);
    for (const key of Object.keys(evidenceRecord)) {
        if (!allowed.has(key)) {
            throw new TypeError(`${path}.evidence must not carry ${JSON.stringify(key)}`);
        }
    }
    const evidence = {};
    for (const member of [...spec.required, ...spec.optional]) {
        const required = spec.required.includes(member);
        if (!Object.hasOwn(evidenceRecord, member)) {
            if (required) {
                throw new TypeError(`${path}.evidence.${member} is required`);
            }
            continue;
        }
        const memberValue = evidenceRecord[member];
        const memberPath = `${path}.evidence.${member}`;
        if (member === 'required') {
            if (!REPOSITORY_DISPOSITIONS.includes(memberValue)) {
                throw new TypeError(`${memberPath} must be a repository disposition`);
            }
            evidence[member] = memberValue;
        }
        else if (member === 'observed') {
            if (!RECEIPT_CLASSIFICATIONS.includes(memberValue)) {
                throw new TypeError(`${memberPath} must be a receipt classification`);
            }
            evidence[member] = memberValue;
        }
        else if (member === 'paths') {
            evidence[member] = failureCausePaths(memberValue, spec.paths, memberPath);
        }
        else if (member === 'error') {
            evidence[member] = failureCauseErrorEvidence(memberValue, memberPath);
        }
        else if (member === 'cause') {
            evidence[member] = validateFailureCause(memberValue, memberPath, depth + 1);
        }
        else {
            evidence[member] = failureCauseString(memberValue, memberPath);
        }
    }
    return Object.freeze({
        code: code,
        evidence: Object.freeze(evidence),
    });
}
/**
 * Validate, detach, and freeze one failure cause (DR-063 §1). The check is
 * closed per code: exactly the evidence members that code names, nothing else,
 * and a `child-failed` cause nests at most four deep. A value this rejects is
 * not a cause, so a caller omits it rather than publishing an invented one.
 */
export function assertPlaybookFailureCause(value) {
    return validateFailureCause(value, 'playbook failure cause', 1);
}
