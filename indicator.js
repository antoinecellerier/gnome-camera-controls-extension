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
        _init(control, devPath, autoManaged = false, onChanged = null) {
            super._init({activate: false, can_focus: false, reactive: true});
            this._control = control;
            this._devPath = devPath;
            this._autoManaged = autoManaged;
            this._onChanged = onChanged;
            this._pendingTimeout = 0;
            this._verifyTimeout = 0;
            this._writeSerial = 0;

            const range = control.max - control.min;
            const startFrac = range > 0 ? (control.current - control.min) / range : 0;

            this._nameLabel = new St.Label({
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                style_class: 'ccx-name',
            });

            this._slider = new Slider(Math.max(0, Math.min(1, startFrac)));
            this._slider.x_expand = true;
            this._slider.y_align = Clutter.ActorAlign.CENTER;
            this._slider.add_style_class_name('ccx-slider');
            this._slider.connect('notify::value', () => this._onSliderChanged());

            this._valueLabel = new St.Label({
                text: String(control.current),
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: false,
                style_class: 'ccx-value',
            });

            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'ccx-row',
            });
            row.add_child(this._nameLabel);
            row.add_child(this._slider);
            row.add_child(this._valueLabel);

            this.add_child(row);

            this._renderLabel();
            if (this._autoManaged) this._applyLockedStyling();
        }

        _renderLabel() {
            const name = this._control.name;
            if (this._autoManaged) {
                this._nameLabel.text = `${name} 🔒`;
            } else if (this._pending) {
                this._nameLabel.text = `${name} ⌛`;
            } else {
                this._nameLabel.text = name;
            }
        }

        _applyLockedStyling() {
            this._nameLabel.add_style_class_name('ccx-locked-text');
            this._valueLabel.add_style_class_name('ccx-locked-text');
            this._slider.add_style_class_name('ccx-locked-slider');
        }

        _currentValue() {
            const {min, max} = this._control;
            return Math.max(min, Math.min(max, Math.round(min + this._slider.value * (max - min))));
        }

        _onSliderChanged() {
            this._valueLabel.text = String(this._currentValue());
            this._onChanged?.();
            if (this._autoManaged) return;

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
            if (serial !== this._writeSerial || this._pendingTimeout) return;
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
            this._setPending(Math.abs(actual - expected) > tolerance);
        }

        _setPending(pending) {
            if (this._pending === pending) return;
            this._pending = pending;
            this._renderLabel();
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

        isAtDefault() {
            const def = this._control.default;
            if (!Number.isFinite(def)) return true;
            return this._currentValue() === def;
        }

        resetToDefault() {
            if (this._autoManaged) return;
            const def = this._control.default;
            if (!Number.isFinite(def)) return;
            const range = this._control.max - this._control.min;
            const frac = range > 0 ? (def - this._control.min) / range : 0;
            this._slider.value = Math.max(0, Math.min(1, frac));
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

function renderStateLabel(baseLabel, {autoManaged, pending}) {
    if (autoManaged) return `${baseLabel} 🔒`;
    if (pending) return `${baseLabel} ⌛`;
    return baseLabel;
}

async function verifyWrite(devPath, name, expected, onResult) {
    try {
        const actual = await readControlValue(devPath, name);
        onResult(actual);
    } catch (e) {
        logError?.(e, `readControlValue ${name}`);
    }
}

const CameraControlBoolItem = GObject.registerClass(
    class CameraControlBoolItem extends PopupMenu.PopupSwitchMenuItem {
        _init(control, devPath, autoManaged = false, onChanged = null) {
            super._init(control.name, control.current === 1);
            this._control = control;
            this._devPath = devPath;
            this._autoManaged = autoManaged;
            this._onChanged = onChanged;
            this._userValue = control.current === 1 ? 1 : 0;
            this._pending = false;
            this._writeSerial = 0;
            this._verifyTimeout = 0;
            if (autoManaged)
                this.label.add_style_class_name('ccx-locked-text');
            this._renderLabel();
            this.connect('toggled', (_i, state) => this._onToggled(state));
        }

        _renderLabel() {
            this.label.text = renderStateLabel(this._control.name, {
                autoManaged: this._autoManaged,
                pending: this._pending,
            });
        }

        async _onToggled(state) {
            this._userValue = state ? 1 : 0;
            this._onChanged?.();
            if (this._autoManaged) return;
            this._setPending(false);
            const serial = ++this._writeSerial;
            try {
                await setControl(this._devPath, this._control.name, this._userValue,
                    {min: 0, max: 1});
            } catch (e) {
                logError?.(e, `setControl ${this._control.name}`);
                return;
            }
            if (this._verifyTimeout) GLib.source_remove(this._verifyTimeout);
            this._verifyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_DELAY_MS, () => {
                this._verifyTimeout = 0;
                verifyWrite(this._devPath, this._control.name, this._userValue, (actual) => {
                    if (serial !== this._writeSerial) return;
                    this._setPending(actual !== this._userValue);
                });
                return GLib.SOURCE_REMOVE;
            });
        }

        _setPending(pending) {
            if (this._pending === pending) return;
            this._pending = pending;
            this._renderLabel();
        }

        getIntendedValue() {
            return {
                name: this._control.name,
                value: this._userValue,
                min: 0,
                max: 1,
                pending: this._pending === true,
                autoManaged: this._autoManaged === true,
            };
        }

        isAtDefault() {
            const def = this._control.default;
            if (!Number.isFinite(def)) return true;
            return this._userValue === def;
        }

        resetToDefault() {
            if (this._autoManaged) return;
            const def = this._control.default;
            if (!Number.isFinite(def)) return;
            const state = def === 1;
            if (this._userValue === (state ? 1 : 0)) return;
            this.setToggleState(state);
            this._onToggled(state);
        }

        destroy() {
            if (this._verifyTimeout) {
                GLib.source_remove(this._verifyTimeout);
                this._verifyTimeout = 0;
            }
            super.destroy();
        }
    }
);

const CameraControlMenuItem = GObject.registerClass(
    class CameraControlMenuItem extends PopupMenu.PopupSubMenuMenuItem {
        _init(control, devPath, autoManaged = false, onChanged = null) {
            super._init('', false);
            this._control = control;
            this._devPath = devPath;
            this._autoManaged = autoManaged;
            this._onChanged = onChanged;
            this._userValue = control.current;
            this._pending = false;
            this._writeSerial = 0;
            this._verifyTimeout = 0;
            this._itemWidgets = new Map();

            this._valueRange = {
                min: Math.min(...control.items.map(i => i.value)),
                max: Math.max(...control.items.map(i => i.value)),
            };

            if (autoManaged)
                this.label.add_style_class_name('ccx-locked-text');

            for (const item of control.items) {
                const mi = new PopupMenu.PopupMenuItem('');
                mi.connect('activate', () => this._onSelect(item.value));
                this.menu.addMenuItem(mi);
                this._itemWidgets.set(item.value, mi);
            }

            this._updateSelectionMarks();
            this._renderLabel();
        }

        _currentItemLabel() {
            return this._control.items.find(i => i.value === this._userValue)?.label
                ?? String(this._userValue);
        }

        _renderLabel() {
            const base = `${this._control.name}: ${this._currentItemLabel()}`;
            this.label.text = renderStateLabel(base, {
                autoManaged: this._autoManaged,
                pending: this._pending,
            });
        }

        _updateSelectionMarks() {
            for (const [value, widget] of this._itemWidgets) {
                const item = this._control.items.find(i => i.value === value);
                const marker = value === this._userValue ? '● ' : '  ';
                widget.label.text = marker + (item?.label ?? String(value));
            }
        }

        async _onSelect(value) {
            this._userValue = value;
            this._updateSelectionMarks();
            this._renderLabel();
            this._onChanged?.();
            if (this._autoManaged) return;
            this._setPending(false);
            const serial = ++this._writeSerial;
            try {
                await setControl(this._devPath, this._control.name, value, this._valueRange);
            } catch (e) {
                logError?.(e, `setControl ${this._control.name}`);
                return;
            }
            if (this._verifyTimeout) GLib.source_remove(this._verifyTimeout);
            this._verifyTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VERIFY_DELAY_MS, () => {
                this._verifyTimeout = 0;
                verifyWrite(this._devPath, this._control.name, value, (actual) => {
                    if (serial !== this._writeSerial) return;
                    this._setPending(actual !== value);
                });
                return GLib.SOURCE_REMOVE;
            });
        }

        _setPending(pending) {
            if (this._pending === pending) return;
            this._pending = pending;
            this._renderLabel();
        }

        getIntendedValue() {
            return {
                name: this._control.name,
                value: this._userValue,
                min: this._valueRange.min,
                max: this._valueRange.max,
                pending: this._pending === true,
                autoManaged: this._autoManaged === true,
            };
        }

        isAtDefault() {
            const def = this._control.default;
            if (!Number.isFinite(def)) return true;
            return this._userValue === def;
        }

        resetToDefault() {
            if (this._autoManaged) return;
            const def = this._control.default;
            if (!Number.isFinite(def)) return;
            if (this._userValue === def) return;
            this._onSelect(def);
        }

        destroy() {
            if (this._verifyTimeout) {
                GLib.source_remove(this._verifyTimeout);
                this._verifyTimeout = 0;
            }
            super.destroy();
        }
    }
);

function makeControlItem(control, devPath, autoManaged, onChanged) {
    switch (control.type) {
        case 'bool':
            return new CameraControlBoolItem(control, devPath, autoManaged, onChanged);
        case 'menu':
        case 'intmenu':
            return new CameraControlMenuItem(control, devPath, autoManaged, onChanged);
        default:
            return new CameraControlSliderItem(control, devPath, autoManaged, onChanged);
    }
}

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
            header.label.add_style_class_name('ccx-title');
            this.menu.addMenuItem(header);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            for (const f of failures) {
                const label = new PopupMenu.PopupMenuItem(
                    f.blocking ? f.label : `${f.label} (optional)`,
                    {reactive: false},
                );
                this.menu.addMenuItem(label);

                const explain = new PopupMenu.PopupMenuItem(f.explanation, {reactive: false});
                explain.label.add_style_class_name('ccx-explain');
                explain.label.add_style_class_name('dim-label');
                this.menu.addMenuItem(explain);

                const fix = new PopupMenu.PopupMenuItem(f.fixCommand, {reactive: false});
                fix.label.add_style_class_name('ccx-fix');
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
            header.label.add_style_class_name('ccx-title');
            this.menu.addMenuItem(header);

            const pathItem = new PopupMenu.PopupMenuItem(devPath, {reactive: false});
            pathItem.label.add_style_class_name('ccx-hint');
            pathItem.label.add_style_class_name('dim-label');
            this.menu.addMenuItem(pathItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            const locked = autoManaged ?? new Set();
            const onChanged = () => this._updateResetVisibility();
            let sawQueued = false, sawLocked = false;
            for (const control of controls) {
                const isLocked = locked.has?.(control.name) ?? false;
                const item = makeControlItem(control, devPath, isLocked, onChanged);
                this._sliderItems.push(item);
                this.menu.addMenuItem(item);
                if (isLocked) sawLocked = true;
                else sawQueued = true;
            }

            this._resetSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._resetSeparator);
            this._resetItem = new PopupMenu.PopupMenuItem('Reset to defaults');
            this._resetItem.connect('activate', () => this._resetAll());
            this.menu.addMenuItem(this._resetItem);
            this._updateResetVisibility();

            const legendParts = [];
            if (sawQueued) legendParts.push('⌛ = queued for next camera open');
            if (sawLocked) legendParts.push('🔒 = auto-managed by libcamera');
            if (legendParts.length) {
                const footer = new PopupMenu.PopupMenuItem(legendParts.join(' · '), {reactive: false});
                footer.label.add_style_class_name('ccx-hint');
                footer.label.add_style_class_name('dim-label');
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

        _updateResetVisibility() {
            if (!this._resetItem) return;
            const anyChanged = (this._sliderItems ?? []).some(it => {
                const {autoManaged} = it.getIntendedValue();
                return !autoManaged && !it.isAtDefault();
            });
            this._resetItem.visible = anyChanged;
            this._resetSeparator.visible = anyChanged;
        }

        _resetAll() {
            for (const item of this._sliderItems ?? [])
                item.resetToDefault();
            this._updateResetVisibility();
        }

        hideAll() {
            this.visible = false;
            this.menu.removeAll();
            this._sliderItems = [];
            this._devPath = null;
            this._resetItem = null;
            this._resetSeparator = null;
        }
    }
);
