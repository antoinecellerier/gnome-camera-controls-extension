import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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

        showControl() {
            this.menu.removeAll();
            this._icon.icon_name = 'camera-photo-symbolic';
            const placeholder = new PopupMenu.PopupMenuItem('(sliders not implemented yet)', {reactive: false});
            this.menu.addMenuItem(placeholder);
            this.visible = true;
        }

        hideAll() {
            this.visible = false;
            this.menu.removeAll();
        }
    }
);
