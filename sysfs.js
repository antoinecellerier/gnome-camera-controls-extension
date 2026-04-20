// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {spawn} from './process.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

async function readTextFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [bytes] = await file.load_contents_async(null);
        return new TextDecoder().decode(bytes).trim();
    } catch {
        return null;
    }
}

function hasUdevadm() {
    return GLib.find_program_in_path('udevadm') !== null;
}

async function sysfsPathFor(devPath) {
    if (!hasUdevadm()) return null;
    try {
        const out = await spawn(['udevadm', 'info', '--query=path', `--name=${devPath}`]);
        return out.trim();
    } catch {
        return null;
    }
}

async function acpiPathFromSysfsPath(sysfsPath) {
    if (!sysfsPath || sysfsPath.includes('..')) return null;
    let p = '/sys' + (sysfsPath.startsWith('/') ? sysfsPath : `/${sysfsPath}`);
    while (p && p !== '/sys' && p !== '/') {
        if (!p.startsWith('/sys/')) return null; // defensive: never leave /sys
        const acpi = await readTextFile(`${p}/firmware_node/path`);
        if (acpi) return acpi;
        const slash = p.lastIndexOf('/');
        if (slash <= 0) break;
        const parent = p.slice(0, slash);
        if (parent === p) break;
        p = parent;
    }
    return null;
}

export async function resolveCandidate(devPath) {
    const sysfsPath = await sysfsPathFor(devPath);
    const acpiPath = await acpiPathFromSysfsPath(sysfsPath);
    return {devPath, sysfsPath, acpiPath};
}

export function sysfsAncestor(parentSysfs, childSysfs) {
    if (!parentSysfs || !childSysfs) return false;
    return childSysfs === parentSysfs || childSysfs.startsWith(parentSysfs + '/');
}
