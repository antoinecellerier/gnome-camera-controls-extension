// SPDX-License-Identifier: GPL-3.0-or-later
//
// CameraMonitor runs the helper (camera-monitor-helper.js) as a child gjs
// process. All WirePlumber/PipeWire API contact happens in that child, so a
// libpipewire/libwireplumber SIGSEGV can never take gnome-shell with it.
//
// Protocol: newline-delimited JSON on the helper's stdout. See
// camera-monitor-helper.js for the event vocabulary.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const READY_TIMEOUT_MS = 5000;
const SIGTERM = 15;

export class CameraMonitor {
    constructor(helperPath) {
        this._helperPath = helperPath;
        this._proc = null;
        this._stdout = null;
        this._cancellable = null;
        this._listeners = {live: [], idle: [], error: []};
        this._liveSnapshot = null;
        this._stopped = false;
        this._readyResolve = null;
        this._readyReject = null;
        this._readyTimeout = 0;
    }

    on(event, cb) {
        (this._listeners[event] ??= []).push(cb);
    }

    _emit(event, ...args) {
        for (const cb of this._listeners[event] ?? []) {
            try { cb(...args); } catch (e) { logError?.(e, `CameraMonitor listener ${event}`); }
        }
    }

    async start() {
        return new Promise((resolve, reject) => {
            this._readyResolve = resolve;
            this._readyReject = reject;
            this._readyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, READY_TIMEOUT_MS, () => {
                this._readyTimeout = 0;
                this._finishReady(new Error('helper did not emit ready within 5s'));
                return GLib.SOURCE_REMOVE;
            });
            try {
                this._spawn();
            } catch (e) {
                this._finishReady(e);
            }
        });
    }

    _finishReady(err) {
        if (this._readyTimeout) {
            GLib.source_remove(this._readyTimeout);
            this._readyTimeout = 0;
        }
        const resolve = this._readyResolve;
        const reject = this._readyReject;
        this._readyResolve = null;
        this._readyReject = null;
        if (!resolve) return;
        if (err) reject(err);
        else resolve();
    }

    _spawn() {
        this._cancellable = new Gio.Cancellable();
        this._proc = new Gio.Subprocess({
            argv: ['gjs', '-m', this._helperPath],
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        this._proc.init(null);

        this._proc.wait_async(null, (_proc, res) => {
            try { this._proc.wait_finish(res); } catch {}
            if (this._stopped) return;
            this._stopped = true;
            this._finishReady(new Error('helper exited before ready'));
            if (this._liveSnapshot) {
                this._liveSnapshot = null;
                this._emit('idle');
            }
            this._emit('error', new Error('monitor helper exited'));
        });

        this._stdout = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readNextLine();
    }

    _readNextLine() {
        if (this._stopped || !this._stdout) return;
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
            if (this._stopped) return;
            let line = null;
            try {
                const [bytes] = stream.read_line_finish(res);
                if (bytes === null) {
                    // EOF
                    return;
                }
                line = new TextDecoder().decode(bytes);
            } catch (e) {
                if (!this._stopped) this._emit('error', e);
                return;
            }
            this._handleLine(line);
            this._readNextLine();
        });
    }

    _handleLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            logError?.(e, `bad helper line: ${line}`);
            return;
        }

        switch (msg?.type) {
            case 'ready':
                this._finishReady(null);
                break;
            case 'live':
                this._liveSnapshot = msg;
                this._emit('live', msg);
                break;
            case 'idle':
                this._liveSnapshot = null;
                this._emit('idle');
                break;
            case 'fatal':
                this._emit('error', new Error(msg.reason ?? 'helper fatal'));
                break;
            default:
                logError?.(new Error(`unknown helper event type: ${msg?.type}`));
        }
    }

    stop() {
        if (this._stopped) return;
        this._stopped = true;
        this._finishReady(new Error('stopped before ready'));
        if (this._cancellable) {
            try { this._cancellable.cancel(); } catch {}
        }
        if (this._proc) {
            try { this._proc.send_signal(SIGTERM); } catch {}
        }
        this._stdout = null;
        this._proc = null;
        this._liveSnapshot = null;
    }

    getLiveSnapshot() {
        return this._liveSnapshot;
    }
}
