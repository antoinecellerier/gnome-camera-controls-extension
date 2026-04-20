// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {spawn} from './process.js';

export const DEFAULT_CONTROL_ALLOWLIST = Object.freeze([
    'exposure',
    'exposure_absolute',
    'analogue_gain',
    'digital_gain',
    'gain',
    'brightness',
]);

// v4l2 control names are lowercase ASCII letters, digits and underscores,
// with a leading letter. Enforce this shape on *every* control name we ever
// pass to v4l2-ctl, including names coming from user preferences. An argv
// array already blocks shell injection; this blocks category confusion
// (e.g. a user-typed 'control name' of `--set-ctrl=…`).
export const CONTROL_NAME_RE = /^[a-z][a-z0-9_]*$/;

const MAX_DEVICE_INDEX = 64;
const V4L2_CTL = 'v4l2-ctl';

function assertControlName(name) {
    if (typeof name !== 'string' || !CONTROL_NAME_RE.test(name))
        throw new Error(`Invalid control name: ${JSON.stringify(name)}`);
}

function enumerateDevicePaths() {
    const paths = [];
    for (const prefix of ['/dev/v4l-subdev', '/dev/video']) {
        for (let i = 0; i < MAX_DEVICE_INDEX; i++) {
            const p = `${prefix}${i}`;
            if (GLib.file_test(p, GLib.FileTest.EXISTS))
                paths.push(p);
        }
    }
    return paths;
}

function parseListCtrls(stdout) {
    const controls = [];
    for (const rawLine of stdout.split('\n')) {
        const m = rawLine.match(/^\s*(\w+)\s+0x[0-9a-f]+\s+\(([^)]+)\)\s*:\s*(.*)$/);
        if (!m) continue;
        const [, name, type, rest] = m;

        const flagsIdx = rest.indexOf('flags=');
        const preFlags = flagsIdx >= 0 ? rest.slice(0, flagsIdx) : rest;
        const flagsStr = flagsIdx >= 0 ? rest.slice(flagsIdx + 'flags='.length) : '';
        const flags = flagsStr.split(',').map(s => s.trim()).filter(Boolean);

        const kv = {};
        for (const kvMatch of preFlags.matchAll(/(\w+)=(-?\d+)/g))
            kv[kvMatch[1]] = Number(kvMatch[2]);

        controls.push({
            name,
            type,
            min: kv.min,
            max: kv.max,
            step: kv.step ?? 1,
            default: kv.default,
            current: kv.value,
            flags,
            readOnly: flags.includes('read-only'),
            inactive: flags.includes('inactive'),
        });
    }
    return controls;
}

function filterControls(controls, allowlist) {
    const allow = allowlist instanceof Set ? allowlist : new Set(allowlist);
    return controls.filter(c =>
        allow.has(c.name) &&
        !c.readOnly &&
        !c.inactive &&
        Number.isFinite(c.min) &&
        Number.isFinite(c.max) &&
        c.type === 'int'
    );
}

export async function listControls(devPath, allowlist = DEFAULT_CONTROL_ALLOWLIST) {
    const stdout = await spawn([V4L2_CTL, '-d', devPath, '--list-ctrls']);
    return filterControls(parseListCtrls(stdout), allowlist);
}

export async function enumerateCandidates(allowlist = DEFAULT_CONTROL_ALLOWLIST) {
    const candidates = [];
    for (const devPath of enumerateDevicePaths()) {
        try {
            const controls = await listControls(devPath, allowlist);
            if (controls.length > 0)
                candidates.push({devPath, controls});
        } catch {
            // Device has no controls at all, or isn't queryable — skip silently.
        }
    }
    return candidates;
}

// For the prefs UI: every writable, non-read-only integer control found on
// any v4l2 device, ignoring the allowlist entirely. Return value is a sorted
// array of unique names.
export async function enumerateAllWritableControls() {
    const names = new Set();
    for (const devPath of enumerateDevicePaths()) {
        try {
            const stdout = await spawn([V4L2_CTL, '-d', devPath, '--list-ctrls']);
            for (const c of parseListCtrls(stdout)) {
                if (!c.readOnly && !c.inactive && c.type === 'int'
                    && Number.isFinite(c.min) && Number.isFinite(c.max)
                    && CONTROL_NAME_RE.test(c.name))
                    names.add(c.name);
            }
        } catch {
            // unqueryable device — skip
        }
    }
    return [...names].sort();
}

export async function setControl(devPath, name, value, {min, max}) {
    assertControlName(name);
    if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max))
        throw new Error(`setControl numeric args required: value=${value} min=${min} max=${max}`);
    const clamped = Math.max(min, Math.min(max, Math.round(value)));
    await spawn([V4L2_CTL, '-d', devPath, '-c', `${name}=${clamped}`]);
    return clamped;
}

export async function readControlValue(devPath, name) {
    assertControlName(name);
    const stdout = await spawn([V4L2_CTL, '-d', devPath, '-C', name]);
    const m = stdout.match(/:\s*(-?\d+)/);
    if (!m) throw new Error(`Could not parse value from: ${stdout}`);
    return Number(m[1]);
}
