# Active-camera → control-device mapping

## Problem

PipeWire tells us *which node is streaming* (a `Wp.Node` with `media.class = "Video/Source"` in state `RUNNING`). The control plane needs a `/dev/v4l-subdev*` or `/dev/video*` path to hand to `v4l2-ctl`. These two worlds don't carry the same identifiers, and on multi-camera machines picking "the first device that exposes some control" silently exposes the wrong camera's sliders.

## Algorithm

Candidates are enumerated once on enable:

```
for path in /dev/v4l-subdev* , /dev/video*:
    controls = v4l2-ctl -d path --list-ctrls   # keep writable + allowlisted
    if controls is empty: skip
    sysfsPath = udevadm info --query=path --name=path
    candidates.push({devPath: path, sysfsPath, controls})
```

On each `camera-live` event with a running `Wp.Node` we match one candidate:

1. **v4l2 backend path.** If the node has `api.v4l2.path`, match it to a candidate's `devPath` directly. Usually a UVC webcam.
2. **libcamera backend path.** Else, look up the parent `Wp.Device` via `device.id` in the same ObjectManager. Read its `object.path` / `device.bus-path` and resolve to a sysfs path. Pick the candidate whose `sysfsPath` is that path, or a descendant. Usually an IPU6 sensor subdev.
3. **No match.** Log once and show "Active camera not recognized" in the menu. Never fall back to a guess.

## Worked examples

### IPU6 / libcamera (this machine)

- Running node: `Wp.Node` with `media.class=Video/Source`, no `api.v4l2.path`, `device.id=N`.
- Parent `Wp.Device N`: `device.api=libcamera`, `object.path` resolves under `/sys/devices/pci0000:00/0000:00:05.0/...`.
- Candidate devPath `/dev/v4l-subdev4`, sysfsPath `/sys/devices/pci0000:00/0000:00:05.0/.../v4l-subdev4`.
- Match succeeds via sysfs prefix.

### UVC (typical laptop / USB webcam)

- Running node has `api.v4l2.path=/dev/video0`.
- Match succeeds via direct `devPath` equality on step 1.

### Two-camera machine (built-in + USB cam)

- Built-in candidate: sysfsPath under `/sys/devices/pci.../0000:00:14.0/usb.../` (or a PCI path on IPU6).
- USB cam candidate: sysfsPath under `/sys/devices/pci.../0000:00:14.0/usb2/.../`.
- Running node's parent Device sits under exactly one of those, so the prefix match selects only the active camera.
