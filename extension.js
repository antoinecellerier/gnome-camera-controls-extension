import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {probe} from './prereqs.js';
import {CameraControlsIndicator} from './indicator.js';

export default class CameraControlsExtension extends Extension {
    enable() {
        this._enabled = true;
        this._indicator = new CameraControlsIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._runProbe();
    }

    async _runProbe() {
        const {ok, failures} = await probe();
        if (!this._enabled) return;
        if (failures.length === 0) {
            this._indicator.hideAll();
            return;
        }
        this._indicator.showError(failures, () => {
            if (this._enabled) this._runProbe();
        });
    }

    disable() {
        this._enabled = false;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
