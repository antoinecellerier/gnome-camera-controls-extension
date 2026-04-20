// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {spawn} from './process.js';

export const DEFAULT_CONTROL_ALLOWLIST = Object.freeze([
    // IPU6 / generic sensor subdev
    'exposure',
    'analogue_gain',
    'digital_gain',
    // UVC + shared
    'exposure_absolute',
    'exposure_time_absolute',
    'gain',
    'brightness',
    'contrast',
    'saturation',
    'sharpness',
    'backlight_compensation',
    'white_balance_temperature',
    // Bool
    'white_balance_automatic',
    'white_balance_temperature_auto',
    'exposure_dynamic_framerate',
    // Menu
    'auto_exposure',
    'power_line_frequency',
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
    let currentMenu = null;
    for (const rawLine of stdout.split('\n')) {
        // Menu-item continuation lines: tab-indented "<idx>: <label>".
        if (currentMenu) {
            const mi = rawLine.match(/^\s+(-?\d+):\s+(.+)$/);
            if (mi) {
                currentMenu.items.push({value: Number(mi[1]), label: mi[2].trim()});
                continue;
            }
            currentMenu = null; // non-matching line terminates the menu block
        }

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

        const record = {
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
        };
        if (type === 'bool') {
            // v4l2-ctl doesn't emit min/max for bool controls; give the UI a range.
            record.min = 0;
            record.max = 1;
        }
        if (type === 'menu' || type === 'intmenu') {
            record.items = [];
            currentMenu = record;
        }
        controls.push(record);
    }
    return controls;
}

function filterControls(controls, allowlist) {
    const allow = allowlist instanceof Set ? allowlist : new Set(allowlist);
    return controls.filter(c => {
        if (!allow.has(c.name) || c.readOnly || c.inactive) return false;
        switch (c.type) {
            case 'int':
                return Number.isFinite(c.min) && Number.isFinite(c.max);
            case 'bool':
                return Number.isFinite(c.current);
            case 'menu':
            case 'intmenu':
                return Array.isArray(c.items) && c.items.length > 0;
            default:
                return false;
        }
    });
}

export async function listControls(devPath, allowlist = DEFAULT_CONTROL_ALLOWLIST) {
    const stdout = await spawn([V4L2_CTL, '-d', devPath, '--list-ctrls-menus']);
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

// For the prefs UI: every writable, non-read-only control of a type the
// extension can render (int / bool / menu / intmenu), found on any v4l2
// device, ignoring the allowlist entirely. Returns a sorted unique name list.
export async function enumerateAllWritableControls() {
    const names = new Set();
    const renderable = new Set(['int', 'bool', 'menu', 'intmenu']);
    for (const devPath of enumerateDevicePaths()) {
        try {
            const stdout = await spawn([V4L2_CTL, '-d', devPath, '--list-ctrls-menus']);
            for (const c of parseListCtrls(stdout)) {
                if (c.readOnly || c.inactive) continue;
                if (!renderable.has(c.type)) continue;
                if (!CONTROL_NAME_RE.test(c.name)) continue;
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
