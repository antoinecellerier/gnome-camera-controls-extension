// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

// The ESM module map caches rejected imports for the life of the process, so
// a straight `await import('gi://Wp?version=0.5')` that failed before the
// user installed the typelib would keep failing on Retry. Busting the cache
// with a per-probe nonce forces a fresh typelib lookup each call.
let _wpProbeNonce = 0;

async function checkWpTypelib() {
    try {
        await import(`gi://Wp?version=0.5&probe=${_wpProbeNonce++}`);
        return null;
    } catch {
        return {
            id: 'wp-typelib',
            label: 'WirePlumber GIR typelib missing',
            explanation: 'Needed for event-driven camera detection.',
            fixCommand: 'sudo apt install gir1.2-wp-0.5',
            blocking: true,
        };
    }
}

function checkProgram({name, label, explanation, fixCommand, blocking = true}) {
    if (GLib.find_program_in_path(name)) return null;
    return {id: `bin-${name}`, label, explanation, fixCommand, blocking};
}

function checkGjs() {
    if (GLib.find_program_in_path('gjs')) return null;
    return {
        id: 'bin-gjs',
        label: 'gjs not on PATH',
        explanation: 'Required to run the camera monitor helper as a subprocess.',
        fixCommand: 'sudo apt install gjs',
        blocking: true,
    };
}

export async function probe() {
    const failures = [];
    const push = (f) => { if (f) failures.push(f); };

    push(await checkWpTypelib());
    push(checkProgram({
        name: 'v4l2-ctl',
        label: 'v4l2-ctl not on PATH',
        explanation: 'Needed to read and write camera controls.',
        fixCommand: 'sudo apt install v4l-utils',
    }));
    push(checkProgram({
        name: 'udevadm',
        label: 'udevadm not on PATH',
        explanation: 'Needed to map the active libcamera node to its v4l2 control device.',
        fixCommand: 'sudo apt install udev',
        blocking: false,
    }));
    push(checkGjs());

    return {
        ok: failures.every(f => !f.blocking),
        failures,
    };
}
