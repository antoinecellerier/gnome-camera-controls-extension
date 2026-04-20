import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {probe} from './prereqs.js';
import {CameraControlsIndicator} from './indicator.js';
import {CameraMonitor} from './cameraMonitor.js';
import {enumerateCandidates, listControls} from './v4l2.js';

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
                this._candidates = await enumerateCandidates();
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

        // Direct v4l2 backend: node.api.v4l2.path matches a candidate devPath.
        const v4l2Path = CameraMonitor.getProp(node, 'api.v4l2.path');
        if (v4l2Path) {
            const hit = this._candidates.find(c => c.devPath === v4l2Path);
            if (hit) return hit;
        }

        // libcamera backend: sysfs-prefix match via parent Device.
        // Will be implemented in the sysfs-mapping iteration. For now,
        // fall back to the single-candidate case (this IPU6 machine has
        // exactly one, so this degrades gracefully).
        if (this._candidates.length === 1) return this._candidates[0];

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
