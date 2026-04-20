// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    enumerateAllWritableControls,
    DEFAULT_CONTROL_ALLOWLIST,
    CONTROL_NAME_RE,
} from './v4l2.js';

export default class CameraControlsPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Controls',
            icon_name: 'camera-photo-symbolic',
        });
        window.add(page);

        const detectedGroup = new Adw.PreferencesGroup({
            title: 'Detected controls',
            description: 'Writable integer controls found on this machine\'s cameras. Toggle a name to include or exclude it from the panel sliders.',
        });
        page.add(detectedGroup);

        const customGroup = new Adw.PreferencesGroup({
            title: 'Custom allowlist entries',
            description: 'Additional control names to allow even if no camera currently exposes them. Names must match [a-z][a-z0-9_]*.',
        });
        page.add(customGroup);

        let detected = [];
        try {
            detected = await enumerateAllWritableControls();
        } catch (e) {
            logError?.(e, 'enumerateAllWritableControls');
        }

        // Make sure the user always sees at least the defaults and whatever
        // they already have allowed — even if no camera currently exposes
        // them (e.g. the cam is unplugged when they open prefs).
        const existing = new Set(settings.get_strv('allowed-controls'));
        const listed = new Set([...detected, ...DEFAULT_CONTROL_ALLOWLIST, ...existing]);

        const rows = new Map();
        for (const name of [...listed].sort()) {
            const row = new Adw.SwitchRow({
                title: name,
                subtitle: detected.includes(name) ? 'detected on an active device' : 'not currently present',
                active: existing.has(name),
            });
            row.connect('notify::active', () => {
                const current = new Set(settings.get_strv('allowed-controls'));
                if (row.active) current.add(name);
                else current.delete(name);
                settings.set_strv('allowed-controls', [...current].sort());
            });
            detectedGroup.add(row);
            rows.set(name, row);
        }

        const addRow = new Adw.ActionRow({
            title: 'Add a custom control name',
            subtitle: 'e.g. white_balance_temperature. Saved to the allowlist and appears above if a device exposes it.',
        });
        const entry = new Gtk.Entry({
            valign: Gtk.Align.CENTER,
            placeholder_text: 'control_name',
        });
        const addButton = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
        });
        const apply = () => {
            const text = entry.get_text().trim();
            if (!CONTROL_NAME_RE.test(text)) {
                entry.add_css_class('error');
                return;
            }
            entry.remove_css_class('error');
            const current = new Set(settings.get_strv('allowed-controls'));
            current.add(text);
            settings.set_strv('allowed-controls', [...current].sort());
            entry.set_text('');
            // Best-effort UI refresh: add a row inline so users see the effect
            // without reopening the dialog.
            if (!rows.has(text)) {
                const newRow = new Adw.SwitchRow({
                    title: text,
                    subtitle: 'not currently present',
                    active: true,
                });
                newRow.connect('notify::active', () => {
                    const cur = new Set(settings.get_strv('allowed-controls'));
                    if (newRow.active) cur.add(text);
                    else cur.delete(text);
                    settings.set_strv('allowed-controls', [...cur].sort());
                });
                detectedGroup.add(newRow);
                rows.set(text, newRow);
            } else {
                rows.get(text).active = true;
            }
        };
        entry.connect('activate', apply);
        addButton.connect('clicked', apply);
        addRow.add_suffix(entry);
        addRow.add_suffix(addButton);
        customGroup.add(addRow);
    }
}
