// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import {spawn} from './process.js';

function readTextFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return null;
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

function acpiPathFromSysfsPath(sysfsPath) {
    if (!sysfsPath || sysfsPath.includes('..')) return null;
    let p = '/sys' + (sysfsPath.startsWith('/') ? sysfsPath : `/${sysfsPath}`);
    while (p && p !== '/sys' && p !== '/') {
        if (!p.startsWith('/sys/')) return null; // defensive: never leave /sys
        const acpi = readTextFile(`${p}/firmware_node/path`);
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
    const acpiPath = acpiPathFromSysfsPath(sysfsPath);
    return {devPath, sysfsPath, acpiPath};
}

export function sysfsAncestor(parentSysfs, childSysfs) {
    if (!parentSysfs || !childSysfs) return false;
    return childSysfs === parentSysfs || childSysfs.startsWith(parentSysfs + '/');
}
