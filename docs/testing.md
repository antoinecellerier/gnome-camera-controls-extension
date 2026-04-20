# Testing

## Install for local development

```
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/camera-controls@cellerier.net
# log out / log in on Wayland (Alt-F2 → r on X11)
gnome-extensions enable camera-controls@cellerier.net
journalctl --user -f /usr/bin/gnome-shell    # tail logs while testing
```

## End-to-end steps

1. **Idle.** No camera client open → no indicator. `wpctl status` shows no Video/Source in state RUNNING.
2. **Open a webcam consumer.** A real app (`cheese`, Firefox on webcamtests.com, Chromium) or a headless trigger:
   ```
   # find the node.name from `pw-cli ls Node` then substitute it below
   gst-launch-1.0 pipewiresrc target-object=<NODE_NAME> ! videoconvert ! fakesink
   ```
   `libcamerasrc` or `gst-launch-1.0 v4l2src` bypass PipeWire and will NOT trigger the monitor — by design, since anything bypassing PipeWire is something GNOME Shell wouldn't know about either. The indicator should appear *immediately* (event-driven; no poll window).
3. **Controls visible.** Clicking the indicator shows sliders at the values reported by `v4l2-ctl -d <matched> --list-ctrls`. The matched device is logged to journalctl.
4. **Slide each slider** → verify with `v4l2-ctl -d <matched> -C <ctrl>` that the value written matches the slider position.
5. **Multi-camera** (if available): plug in a second camera, open it from a different app, verify the sliders switch to *that* camera's controls.
6. **Close the camera client.** Indicator disappears immediately.
7. **Disable the extension.** Indicator gone. `pgrep -af v4l2-ctl` shows nothing. `wpctl status` no longer lists the extension's client.
8. **Looking Glass.** Enable briefly, then `Alt-F2 → lg`, inspect extension: `_core` / `_om` null after disable.

## Prereq-failure matrix

See [prereqs.md](prereqs.md) for how to simulate each. For each failure, verify:
- Extension enables without throwing.
- Indicator appears with warning icon.
- Menu has a line for *each* failing prereq with a copyable `apt install …` / `systemctl …` command.
- Clicking **Retry** after the fix transitions the indicator to hidden state.

## Hardware-specific notes

- **IPU6 (libcamera backend).** The matched device is typically the sensor subdev (e.g. `/dev/v4l-subdev4`). `wpctl status` shows the camera under the libcamera source client. The `media.class=Video/Source` node has no `api.v4l2.path`; the match goes via ACPI path on the parent Device (see [device-mapping.md](device-mapping.md)).
- **UVC webcam (v4l2 backend).** The matched device is typically `/dev/video0`. The `media.class=Video/Source` node has `api.v4l2.path=/dev/video0` and matches directly.
