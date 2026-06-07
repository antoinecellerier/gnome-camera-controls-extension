# Camera Controls — GNOME Shell extension

Surfaces v4l2 camera controls (exposure, gain, brightness, auto-exposure, white-balance, …) in the top panel while a camera is streaming. Each control is rendered according to its v4l2 type: integers as sliders, booleans as switches, menus as submenus. Uses WirePlumber GIR bindings for event-driven camera-live detection (no polling) and `v4l2-ctl` for the control plane.

| UVC webcam (v4l2 backend) | Built-in camera (libcamera backend) | Preferences |
|:-:|:-:|:-:|
| ![UVC webcam menu](screenshots/uvc-webcam.png) | ![libcamera IPU6 menu](screenshots/libcamera-ipu6.png) | ![preferences dialog](screenshots/preferences.png) |
| sliders, switches, submenus — and `🔒` / `⌛` markers for auto-managed or queued controls | libcamera-backed camera with the sensor subdev as the control device, `⌛` on controls the subdev refuses mid-stream | toggle any writable control the camera exposes, or type in a custom name |

See [docs/](docs/) for architecture, detection, device mapping, prereqs, preferences, security, and testing notes.

## Preferences

The set of v4l2 control names the extension renders as sliders is user-configurable via `gnome-extensions prefs camera-controls@cellerier.net`. Detected controls get a switch row; custom names can be added with a free-text entry (validated as lowercase-letter-digit-underscore identifiers).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

## Runtime dependencies (Debian/Ubuntu)

```
sudo apt install v4l-utils pipewire wireplumber gir1.2-wp-0.5
```

## Install (for local development)

```
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/camera-controls@cellerier.net
# log out / log in to reload the shell (Wayland; GNOME 49+ is Wayland-only)
# on a legacy X11 session (GNOME ≤ 48) you can instead use Alt-F2 → r
gnome-extensions enable camera-controls@cellerier.net
```

## Running on a newer GNOME

`shell-version` in `metadata.json` only lists GNOME versions the extension has been
tested against. GNOME Shell refuses to load an extension whose `shell-version` does
not include the running release. Breaking changes for an extension this small are
rare, so if you upgrade to a GNOME version before the extension is bumped, you can opt
into running it anyway (at your own risk, and globally for *all* extensions):

```
gsettings set org.gnome.shell disable-extension-version-validation true
```
