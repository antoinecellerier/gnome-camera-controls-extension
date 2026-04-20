// SPDX-License-Identifier: GPL-3.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {probe} from './prereqs.js';
import {CameraControlsIndicator} from './indicator.js';
import {CameraMonitor} from './cameraMonitor.js';
import {enumerateCandidates, listControls, setControl} from './v4l2.js';
import {resolveCandidate, sysfsAncestor} from './sysfs.js';

export default class CameraControlsExtension extends Extension {
    enable() {
        try {
            this._enabled = true;
            this._indicator = new CameraControlsIndicator();
            Main.panel.addToStatusArea(this.uuid, this._indicator);
            this._candidates = null;
            this._monitor = null;
            // Per-device map of what we flushed to the subdev on the previous
            // idle. On the next live event we compare against fresh readbacks
            // to detect controls whose value was silently rewritten by
            // libcamera (e.g. AGC still enabled in the IPA tuning).
            this._lastFlushedByDev = new Map();
            this._run().catch(e => logError?.(e, 'CameraControls._run'));
        } catch (e) {
            logError?.(e, 'CameraControls.enable');
        }
    }

    async _run() {
        let failures = [];
        let ok = true;
        try {
            const r = await probe();
            failures = r.failures;
            ok = r.ok;
        } catch (e) {
            logError?.(e, 'probe');
            failures = [{
                id: 'probe-error',
                label: 'Prerequisite probe threw',
                explanation: String(e?.message ?? e),
                fixCommand: 'journalctl --user -b /usr/bin/gnome-shell | tail -40',
                blocking: true,
            }];
            ok = false;
        }
        if (!this._enabled) return;

        if (failures.length > 0) {
            this._indicator.showError(failures, () => this._restart());
        } else {
            this._indicator.hideAll();
        }

        if (!ok) return;

        try {
            await this._startMonitor();
        } catch (e) {
            logError?.(e, '_startMonitor');
            if (this._enabled) {
                this._indicator.showError([{
                    id: 'monitor-start',
                    label: 'Camera monitor helper failed to start',
                    explanation: String(e?.message ?? e),
                    fixCommand: 'journalctl --user -b /usr/bin/gnome-shell | tail -40',
                    blocking: true,
                }], () => this._restart());
            }
        }
    }

    _restart() {
        if (!this._enabled) return;
        this._stopMonitor();
        this._candidates = null;
        this._run().catch(e => logError?.(e, 'CameraControls._run (restart)'));
    }

    async _startMonitor() {
        if (this._monitor) return;
        const helperPath = this.dir.get_child('camera-monitor-helper.js').get_path();
        const monitor = new CameraMonitor(helperPath);
        monitor.on('live', (snapshot) => this._onLive(snapshot).catch(e => logError?.(e, '_onLive')));
        monitor.on('idle', () => this._onIdle());
        monitor.on('error', (err) => this._onMonitorError(err));
        this._monitor = monitor;
        await monitor.start();
    }

    _stopMonitor() {
        if (!this._monitor) return;
        try { this._monitor.stop(); } catch (e) { logError?.(e); }
        this._monitor = null;
    }

    async _onLive(snapshot) {
        if (!this._enabled) return;

        if (!this._candidates) {
            try {
                const raw = await enumerateCandidates();
                this._candidates = await Promise.all(raw.map(async (c) => {
                    const info = await resolveCandidate(c.devPath).catch(() => ({}));
                    return {...c, ...info};
                }));
            } catch (e) {
                logError?.(e, 'enumerateCandidates');
                this._candidates = [];
            }
            if (!this._enabled) return;
        }

        const matched = this._matchCandidate(snapshot);
        if (!matched) {
            this._indicator.showError([{
                id: 'no-match',
                label: 'Active camera not recognized',
                explanation: 'No /dev/v4l-subdev* or /dev/video* matched the live PipeWire source.',
                fixCommand: 'journalctl --user -b /usr/bin/gnome-shell | tail -40',
                blocking: true,
            }], () => this._restart());
            return;
        }

        let freshControls;
        try {
            freshControls = await listControls(matched.devPath);
        } catch (e) {
            logError?.(e, `listControls ${matched.devPath}`);
            freshControls = matched.controls;
        }
        if (!this._enabled) return;

        const autoManaged = this._detectAutoManaged(matched.devPath, freshControls);

        this._indicator.showControl({
            description: snapshot?.description ?? 'Camera',
            devPath: matched.devPath,
            controls: freshControls,
            autoManaged,
        });
    }

    _detectAutoManaged(devPath, freshControls) {
        const prev = this._lastFlushedByDev.get(devPath);
        if (!prev) return new Set();
        const out = new Set();
        for (const c of freshControls) {
            const expected = prev.get(c.name);
            if (expected === undefined) continue;
            const range = c.max - c.min;
            const tolerance = Math.max(1, Math.round(range * 0.01));
            if (Math.abs(c.current - expected) > tolerance)
                out.add(c.name);
        }
        return out;
    }

    _onIdle() {
        if (!this._enabled) return;
        this._flushPendingOnIdle().finally(() => {
            if (this._enabled) this._indicator.hideAll();
        });
    }

    async _flushPendingOnIdle() {
        if (!this._indicator) return;
        const {devPath, controls} = this._indicator.getIntendedValues();
        if (!devPath || !controls?.length) return;
        // With the camera closed, the sensor subdev accepts writes again;
        // anything the user set while streaming applies now and will be in
        // effect the next time a client opens the camera — unless libcamera's
        // AE/AGC rewrites it on next stream start, which we detect on the
        // following live event by comparing freshControls to this map.
        const flushed = new Map();
        for (const c of controls) {
            // Flush every control (even ones previously marked auto-managed):
            // the next live event's readback vs. this map tells us whether
            // they're still auto-managed, so the flag self-heals if the user
            // later changes their libcamera tuning.
            try {
                await setControl(devPath, c.name, c.value, {min: c.min, max: c.max});
                flushed.set(c.name, c.value);
            } catch (e) {
                logError?.(e, `flush setControl ${c.name}`);
            }
        }
        if (flushed.size > 0) this._lastFlushedByDev.set(devPath, flushed);
    }

    _onMonitorError(err) {
        if (!this._enabled) return;
        this._stopMonitor();
        this._indicator.showError([{
            id: 'monitor-error',
            label: 'Camera monitor helper stopped',
            explanation: String(err?.message ?? err ?? 'unknown'),
            fixCommand: 'Click Retry to restart the helper.',
            blocking: true,
        }], () => this._restart());
    }

    _matchCandidate(snapshot) {
        if (!this._candidates?.length) return null;

        if (snapshot?.api_v4l2_path) {
            const hit = this._candidates.find(c => c.devPath === snapshot.api_v4l2_path);
            if (hit) return hit;
        }

        const dev = snapshot?.device;
        if (dev?.api_libcamera_path) {
            const hit = this._candidates.find(c => c.acpiPath === dev.api_libcamera_path);
            if (hit) return hit;
        }
        if (dev?.bus_path) {
            const hit = this._candidates.find(c => c.sysfsPath && sysfsAncestor(dev.bus_path, c.sysfsPath));
            if (hit) return hit;
        }

        return null;
    }

    disable() {
        try {
            this._enabled = false;
            this._stopMonitor();
            this._indicator?.destroy();
            this._indicator = null;
            this._candidates = null;
            this._lastFlushedByDev = null;
        } catch (e) {
            logError?.(e, 'CameraControls.disable');
        }
    }
}
