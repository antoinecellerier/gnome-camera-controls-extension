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
2. **Open a webcam consumer** (e.g. `cheese`). Indicator should appear *immediately* (event-driven; no poll window).
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

- **IPU6 (this dev machine).** Matched device is `/dev/v4l-subdev4`. `wpctl status` shows the camera under the libcamera source client. `media.class=Video/Source` node has no `api.v4l2.path`.
- **UVC webcam (portable target).** Matched device is `/dev/video0`. `media.class=Video/Source` node has `api.v4l2.path=/dev/video0`.
