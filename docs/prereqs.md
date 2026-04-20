# Prerequisites & error surface

On `enable()`, before wiring anything up, `prereqs.js` runs a fast probe. If anything fails the indicator mounts in **error** mode immediately — a warning icon with an actionable popup — instead of silently doing nothing.

## Probes

| id             | check                                                                 | fix (Debian)                                      | blocking |
|----------------|-----------------------------------------------------------------------|---------------------------------------------------|----------|
| `wp-typelib`   | `import Wp from 'gi://Wp'` succeeds                                    | `sudo apt install gir1.2-wp-0.5`                  | yes      |
| `v4l2-ctl`     | `GLib.find_program_in_path('v4l2-ctl')` non-null                       | `sudo apt install v4l-utils`                      | yes      |
| `pipewire`     | `Wp.Core.connect()` fires `connected` within 3s                        | `systemctl --user restart pipewire wireplumber`   | yes      |
| `udevadm`      | `GLib.find_program_in_path('udevadm')` non-null                        | `sudo apt install udev`                           | soft     |
| `candidates`   | at least one v4l2 device exposes an allowlisted writable control       | (hardware / driver issue; see journalctl)         | yes      |

"soft" means the probe still surfaces a warning entry but the extension continues operating with a degraded fallback (in the `udevadm` case, only the direct `api.v4l2.path` match works, not the libcamera sysfs-prefix match).

## Error UI

- Warning icon (`dialog-warning-symbolic`) permanently visible while the extension is enabled and any hard prereq is failing.
- Popup menu lists each failing prereq on its own line:
  - `<Label>`  — short human name
  - `<Explanation>` — one sentence
  - `<Fix command>` — monospace styled (class `camera-controls-error-fix`) so it reads as copyable
- **Retry** menu item at the bottom re-runs the probe. On success, the indicator transitions into the normal hidden state without a disable/enable cycle.

## Simulating each failure for testing

- `wp-typelib`: launch shell with `GI_TYPELIB_PATH=/tmp gnome-shell --replace` (skip system path), or `sudo apt purge gir1.2-wp-0.5` briefly.
- `v4l2-ctl`: `sudo mv /usr/bin/v4l2-ctl /usr/bin/v4l2-ctl.bak`. Restore after.
- `pipewire`: `systemctl --user stop pipewire pipewire.socket wireplumber`. Restart after.
- `udevadm`: rename the binary (same pattern as v4l2-ctl).
- `candidates`: `sudo chmod 600 /dev/v4l-subdev* /dev/video*` so enumeration returns nothing. Restore with `chmod 660` or reboot.
