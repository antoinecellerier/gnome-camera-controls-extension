// SPDX-License-Identifier: GPL-3.0-or-later

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
        _init(control, devPath, autoManaged = false) {
            super._init({activate: false, can_focus: false, reactive: true});
            this._control = control;
            this._devPath = devPath;
            this._autoManaged = autoManaged;
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

            if (this._autoManaged) this._applyAutoManagedStyling();
        }

        _applyAutoManagedStyling() {
            this._nameLabel.text = `${this._control.name} 🔒`;
            this._nameLabel.set_style('min-width: 9em; color: #999; text-decoration: line-through;');
            this._valueLabel.set_style('min-width: 3.5em; text-align: right; color: #999;');
            this._slider.set_style('min-width: 10em; margin: 0 8px; opacity: 0.5;');
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
            this._valueLabel.text = String(this._currentValue());
            if (this._autoManaged) return; // writing is futile; just track the slider

            this._setPending(false);
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
            if (this._pendingTimeout) return;
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
            // Leave the slider where the user put it. If the subdev refused the
            // write mid-capture, mark the row as "pending": the value will be
            // re-applied when the camera goes idle (see extension.js _onIdle).
            this._setPending(Math.abs(actual - expected) > tolerance);
        }

        _setPending(pending) {
            if (this._pending === pending) return;
            this._pending = pending;
            if (pending) {
                this._nameLabel.set_style('min-width: 9em; color: #eebb55;');
                this._nameLabel.text = `${this._control.name} ⌛`;
                this._valueLabel.set_style('min-width: 3.5em; text-align: right; color: #eebb55;');
            } else {
                this._nameLabel.set_style('min-width: 9em;');
                this._nameLabel.text = this._control.name;
                this._valueLabel.set_style('min-width: 3.5em; text-align: right;');
            }
        }

        getIntendedValue() {
            return {
                name: this._control.name,
                value: this._currentValue(),
                min: this._control.min,
                max: this._control.max,
                pending: this._pending === true,
                autoManaged: this._autoManaged === true,
            };
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

        showControl({description, devPath, controls, autoManaged}) {
            this.menu.removeAll();
            this._icon.icon_name = 'camera-photo-symbolic';
            this._sliderItems = [];
            this._devPath = devPath;

            const header = new PopupMenu.PopupMenuItem(description ?? 'Camera', {reactive: false});
            header.label.set_style('font-weight: bold;');
            this.menu.addMenuItem(header);

            const pathItem = new PopupMenu.PopupMenuItem(devPath, {reactive: false});
            pathItem.label.set_style('font-size: smaller; opacity: 0.6;');
            this.menu.addMenuItem(pathItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const locked = autoManaged ?? new Set();
            let sawQueued = false, sawLocked = false;
            for (const control of controls) {
                const isLocked = locked.has?.(control.name) ?? false;
                const item = new CameraControlSliderItem(control, devPath, isLocked);
                this._sliderItems.push(item);
                this.menu.addMenuItem(item);
                if (isLocked) sawLocked = true;
                else sawQueued = true;
            }

            const legendParts = [];
            if (sawQueued) legendParts.push('⌛ = queued for next camera open');
            if (sawLocked) legendParts.push('🔒 = auto-managed by libcamera');
            if (legendParts.length) {
                const footer = new PopupMenu.PopupMenuItem(legendParts.join(' · '), {reactive: false});
                footer.label.set_style('font-size: smaller; opacity: 0.5;');
                this.menu.addMenuItem(footer);
            }

            this.visible = true;
        }

        getIntendedValues() {
            return {
                devPath: this._devPath ?? null,
                controls: (this._sliderItems ?? []).map(it => it.getIntendedValue()),
            };
        }

        hideAll() {
            this.visible = false;
            this.menu.removeAll();
            this._sliderItems = [];
            this._devPath = null;
        }
    }
);
