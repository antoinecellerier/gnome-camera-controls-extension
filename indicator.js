import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {setControl, readControlValue} from './v4l2.js';

const DEBOUNCE_MS = 100;
const VERIFY_DELAY_MS = 300;

const CameraControlSliderItem = GObject.registerClass(
    class CameraControlSliderItem extends PopupMenu.PopupBaseMenuItem {
        _init(control, devPath) {
            super._init({activate: false, can_focus: false, reactive: true});
            this._control = control;
            this._devPath = devPath;
            this._pendingTimeout = 0;
            this._verifyTimeout = 0;
            this._writeSerial = 0;
            this._ignoreNextChange = false;

            const range = control.max - control.min;
            const startFrac = range > 0 ? (control.current - control.min) / range : 0;

            this._nameLabel = new St.Label({
                text: control.name,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                style: 'min-width: 9em;',
            });

            this._slider = new Slider(Math.max(0, Math.min(1, startFrac)));
            this._slider.x_expand = true;
            this._slider.y_align = Clutter.ActorAlign.CENTER;
            this._slider.set_style('min-width: 10em; margin: 0 8px;');
            this._slider.connect('notify::value', () => this._onSliderChanged());

            this._valueLabel = new St.Label({
                text: String(control.current),
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                style: 'min-width: 3.5em; text-align: right;',
            });

            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style: 'spacing: 4px;',
            });
            row.add_child(this._nameLabel);
            row.add_child(this._slider);
            row.add_child(this._valueLabel);

            this.add_child(row);
        }

        _currentValue() {
            const {min, max} = this._control;
            return Math.max(min, Math.min(max, Math.round(min + this._slider.value * (max - min))));
        }

        _valueToFrac(value) {
            const range = this._control.max - this._control.min;
            return range > 0 ? (value - this._control.min) / range : 0;
        }

        _onSliderChanged() {
            if (this._ignoreNextChange) {
                this._ignoreNextChange = false;
                return;
            }
            // User interaction clears any prior "overridden" marking.
            this._setOverridden(false);
            this._valueLabel.text = String(this._currentValue());
            if (this._pendingTimeout) GLib.source_remove(this._pendingTimeout);
            this._pendingTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                this._pendingTimeout = 0;
                this._flushAsync().catch(e => logError?.(e));
                return GLib.SOURCE_REMOVE;
            });
        }

        async _flushAsync() {
            const serial = ++this._writeSerial;
            const target = this._currentValue();
            try {
                await setControl(this._devPath, this._control.name, target, this._control);
            } catch (e) {
                logError?.(e, `setControl ${this._devPath} ${this._control.name}`);
                return;
            }
            if (this._verifyTimeout) GLib.source_remove(this._verifyTimeout);
            this._verifyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_DELAY_MS, () => {
                this._verifyTimeout = 0;
                this._verifyAsync(target, serial).catch(e => logError?.(e));
                return GLib.SOURCE_REMOVE;
            });
        }

        async _verifyAsync(expected, serial) {
            if (serial !== this._writeSerial) return;
            if (this._pendingTimeout) return; // newer drag in-flight
            let actual;
            try {
                actual = await readControlValue(this._devPath, this._control.name);
            } catch (e) {
                logError?.(e, `readControlValue ${this._control.name}`);
                return;
            }
            if (serial !== this._writeSerial || this._pendingTimeout) return;
            const range = this._control.max - this._control.min;
            const tolerance = Math.max(1, Math.round(range * 0.01));
            if (Math.abs(actual - expected) > tolerance) {
                this._snapSliderTo(actual);
                this._setOverridden(true);
            }
        }

        _snapSliderTo(value) {
            this._valueLabel.text = String(value);
            this._ignoreNextChange = true;
            this._slider.value = Math.max(0, Math.min(1, this._valueToFrac(value)));
        }

        _setOverridden(overridden) {
            if (this._overridden === overridden) return;
            this._overridden = overridden;
            if (overridden) {
                this._nameLabel.set_style('min-width: 9em; color: #eebb55;');
                this._nameLabel.text = `⚠ ${this._control.name}`;
            } else {
                this._nameLabel.set_style('min-width: 9em;');
                this._nameLabel.text = this._control.name;
            }
        }

        destroy() {
            if (this._pendingTimeout) {
                GLib.source_remove(this._pendingTimeout);
                this._pendingTimeout = 0;
            }
            if (this._verifyTimeout) {
                GLib.source_remove(this._verifyTimeout);
                this._verifyTimeout = 0;
            }
            super.destroy();
        }
    }
);

export const CameraControlsIndicator = GObject.registerClass(
    class CameraControlsIndicator extends PanelMenu.Button {
        _init() {
            super._init(0.0, 'Camera Controls');
            this._icon = new St.Icon({
                icon_name: 'camera-photo-symbolic',
                style_class: 'system-status-icon',
            });
            this.add_child(this._icon);
            this.visible = false;
        }

        showError(failures, onRetry) {
            this.menu.removeAll();
            this._icon.icon_name = 'dialog-warning-symbolic';

            const header = new PopupMenu.PopupMenuItem('Camera Controls — setup required', {reactive: false});
            header.label.set_style('font-weight: bold;');
            this.menu.addMenuItem(header);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (const f of failures) {
                const label = new PopupMenu.PopupMenuItem(f.label, {reactive: false});
                if (!f.blocking)
                    label.label.set_style('color: #eebb55;');
                this.menu.addMenuItem(label);

                const explain = new PopupMenu.PopupMenuItem(f.explanation, {reactive: false});
                explain.label.set_style('font-size: smaller; padding-left: 1em;');
                this.menu.addMenuItem(explain);

                const fix = new PopupMenu.PopupMenuItem(f.fixCommand, {reactive: false});
                fix.label.add_style_class_name('camera-controls-error-fix');
                fix.label.set_style('padding-left: 1em;');
                this.menu.addMenuItem(fix);

                this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            }

            const retry = new PopupMenu.PopupMenuItem('Retry');
            retry.connect('activate', () => {
                this.menu.close();
                if (onRetry) onRetry();
            });
            this.menu.addMenuItem(retry);

            this.visible = true;
        }

        showControl({description, devPath, controls}) {
            this.menu.removeAll();
            this._icon.icon_name = 'camera-photo-symbolic';

            const header = new PopupMenu.PopupMenuItem(description ?? 'Camera', {reactive: false});
            header.label.set_style('font-weight: bold;');
            this.menu.addMenuItem(header);

            const pathItem = new PopupMenu.PopupMenuItem(devPath, {reactive: false});
            pathItem.label.set_style('font-size: smaller; opacity: 0.6;');
            this.menu.addMenuItem(pathItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (const control of controls) {
                this.menu.addMenuItem(new CameraControlSliderItem(control, devPath));
            }

            this.visible = true;
        }

        hideAll() {
            this.visible = false;
            this.menu.removeAll();
        }
    }
);
