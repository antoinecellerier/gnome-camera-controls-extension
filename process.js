// SPDX-License-Identifier: GPL-3.0-or-later
//
// Async subprocess helper used by the v4l2 and sysfs modules. Always invoked
// with an argv array (never a shell command line) so no caller can shell-inject
// regardless of what strings they pass in.

import Gio from 'gi://Gio';

export async function spawn(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = new Gio.Subprocess({
                argv,
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });
            proc.init(null);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (_, res) => {
            try {
                const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                const exit = proc.get_exit_status();
                if (exit !== 0) {
                    const err = new Error(`${argv.join(' ')} exited ${exit}: ${stderr.trim()}`);
                    err.exitStatus = exit;
                    err.stderr = stderr;
                    reject(err);
                    return;
                }
                resolve(stdout);
            } catch (e) {
                reject(e);
            }
        });
    });
}
