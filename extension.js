import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {probe} from './prereqs.js';
import {CameraControlsIndicator} from './indicator.js';
import {CameraMonitor} from './cameraMonitor.js';
import {enumerateCandidates, listControls} from './v4l2.js';
import {resolveCandidate, sysfsAncestor} from './sysfs.js';

export default class CameraControlsExtension extends Extension {
    enable() {
        this._enabled = true;
        this._indicator = new CameraControlsIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._candidates = null;
        this._monitor = null;
        this._run();
    }

    async _run() {
        const {ok, failures} = await probe();
        if (!this._enabled) return;

        if (failures.length > 0) {
            this._indicator.showError(failures, () => {
                if (this._enabled) {
                    this._stopMonitor();
                    this._run();
                }
            });
        } else {
            this._indicator.hideAll();
        }

        if (!ok) return;

        await this._startMonitor();
    }

    async _startMonitor() {
        if (this._monitor) return;
        this._monitor = new CameraMonitor();
        this._monitor.on('live', (node) => this._onLive(node));
        this._monitor.on('idle', () => this._onIdle());
        try {
            await this._monitor.start();
        } catch (e) {
            logError?.(e, 'CameraMonitor.start');
            this._monitor = null;
        }
    }

    _stopMonitor() {
        if (this._monitor) {
            try { this._monitor.stop(); } catch (e) { logError?.(e); }
            this._monitor = null;
        }
    }

    async _onLive(node) {
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
                return;
            }
            if (!this._enabled) return;
        }

        const matched = this._matchCandidate(node);
        if (!matched) {
            this._indicator.showError([{
                id: 'no-match',
                label: 'Active camera not recognized',
                explanation: 'No /dev/v4l-subdev* or /dev/video* matched the live PipeWire source.',
                fixCommand: 'Check journalctl --user -f for details.',
                blocking: true,
            }], () => {
                this._candidates = null;
                if (this._enabled) this._onLive(node);
            });
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

        this._indicator.showControl({
            description: CameraMonitor.getProp(node, 'node.description')
                ?? CameraMonitor.getProp(node, 'node.name')
                ?? 'Camera',
            devPath: matched.devPath,
            controls: freshControls,
        });
    }

    _onIdle() {
        if (!this._enabled) return;
        this._indicator.hideAll();
    }

    _matchCandidate(node) {
        if (!this._candidates?.length) return null;

        // 1) v4l2 backend (UVC): node's api.v4l2.path equals a candidate's devPath.
        const v4l2Path = CameraMonitor.getProp(node, 'api.v4l2.path');
        if (v4l2Path) {
            const hit = this._candidates.find(c => c.devPath === v4l2Path);
            if (hit) return hit;
        }

        // 2) libcamera backend: resolve parent Wp.Device, compare ACPI path
        //    (or sysfs prefix as a fallback) against each candidate.
        const deviceId = CameraMonitor.getProp(node, 'device.id');
        const parent = deviceId && this._monitor
            ? this._monitor.findDeviceByBoundId(parseInt(deviceId, 10))
            : null;
        if (parent) {
            const libcameraAcpi = CameraMonitor.getProp(parent, 'api.libcamera.path');
            if (libcameraAcpi) {
                const hit = this._candidates.find(c => c.acpiPath === libcameraAcpi);
                if (hit) return hit;
            }
            const busPath = CameraMonitor.getProp(parent, 'device.bus-path');
            if (busPath) {
                const hit = this._candidates.find(c => c.sysfsPath && sysfsAncestor(busPath, c.sysfsPath));
                if (hit) return hit;
            }
        }

        return null;
    }

    disable() {
        this._enabled = false;
        this._stopMonitor();
        this._indicator?.destroy();
        this._indicator = null;
        this._candidates = null;
    }
}
