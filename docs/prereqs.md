# Prerequisites & error surface

On `enable()`, before wiring anything up, `prereqs.js` runs a fast probe. If anything fails the indicator mounts in **error** mode immediately — a warning icon with an actionable popup — instead of silently doing nothing.

## Probes

| id             | check                                                                 | fix (Debian)                                      | blocking |
|----------------|-----------------------------------------------------------------------|---------------------------------------------------|----------|
| `wp-typelib`   | `await import('gi://Wp?version=0.5')` succeeds                        | `sudo apt install gir1.2-wp-0.5`                  | yes      |
| `bin-v4l2-ctl` | `GLib.find_program_in_path('v4l2-ctl')` non-null                       | `sudo apt install v4l-utils`                      | yes      |
| `bin-gjs`      | `GLib.find_program_in_path('gjs')` non-null                            | `sudo apt install gjs`                            | yes      |
| `bin-udevadm`  | `GLib.find_program_in_path('udevadm')` non-null                        | `sudo apt install udev`                           | soft     |

The PipeWire-reachable check is **not** done in this probe — it would need to call `Wp.init()` in gnome-shell's process, which crashed the shell. Instead, `camera-monitor-helper.js` is spawned as a subprocess; failure to emit its `ready` JSON event within 5 seconds is surfaced as a `monitor-start` error in the indicator (with a **Retry** button that respawns the helper). Candidate enumeration runs after the first `live` event and reports `no-match` if the running PipeWire source can't be mapped to any `/dev/v4l-subdev*` / `/dev/video*`.

## Why a subprocess

`Wp.init(Wp.InitFlags.ALL)` SIGSEGVs gnome-shell the instant it's called in-process on a session where libpipewire is already loaded (every modern GNOME desktop — the shell uses it for audio). Likely cause: `ALL` includes `SET_PW_LOG | SET_GLIB_LOG`, which replace pipewire and glib log handlers after the shell has already installed its own. Rather than tune init flags and hope, we run all WirePlumber code in a child gjs process so a native crash there can never propagate into gnome-shell. The cost is ~37 MB RSS and ~0% idle CPU.

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
