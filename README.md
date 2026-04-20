# Camera Controls — GNOME Shell extension

Shows sliders for v4l2 camera controls (exposure, gain, brightness) in the top panel **only while a camera is streaming**. Uses WirePlumber GIR bindings for event-driven camera-live detection (no polling) and `v4l2-ctl` for the control plane.

See [docs/](docs/) for architecture, detection, device mapping, prereqs, and testing notes.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

## Runtime dependencies (Debian/Ubuntu)

```
sudo apt install v4l-utils pipewire wireplumber gir1.2-wp-0.5
```

## Install (for local development)

```
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/camera-controls@cellerier.net
# log out / log in on Wayland (or Alt-F2 → r on X11)
gnome-extensions enable camera-controls@cellerier.net
```
