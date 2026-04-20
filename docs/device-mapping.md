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
2. **libcamera backend path (ACPI match).** Else, look up the parent `Wp.Device` via `device.id` in the same ObjectManager and read its `api.libcamera.path`. On Intel IPU6 hardware this is the sensor's ACPI path (e.g. `\_SB_.PC00.LNK1`). Compare it directly against each candidate's `acpiPath` — which we read at enumerate time from `/sys/.../firmware_node/path` as we walk up from the `/dev/v4l-subdev*` sysfs node.
3. **libcamera backend fallback (sysfs prefix).** If ACPI match fails, try a `device.bus-path` → sysfs-ancestor match. This catches cameras whose libcamera path isn't ACPI-based.
4. **No match.** Log once and show "Active camera not recognized" in the menu. Never fall back to a guess.

On single-camera IPU6 machines this comfortably picks the right subdev without requiring the fallback; on multi-camera machines each camera's `api.libcamera.path` resolves to a distinct ACPI identifier that uniquely addresses one sensor.

## Worked examples

### IPU6 / libcamera (this machine)

- Running node: `Wp.Node` with `media.class=Video/Source`, no `api.v4l2.path`, `device.id=87`.
- Parent `Wp.Device 87`: `device.api=libcamera`, `api.libcamera.path=\_SB_.PC00.LNK1`.
- Candidate `/dev/v4l-subdev4`: `acpiPath=\_SB_.PC00.LNK1` (read from `/sys/.../i2c-INT3474:01/firmware_node/path`).
- Match succeeds on ACPI equality at step 2.

### UVC (typical laptop / USB webcam)

- Running node has `api.v4l2.path=/dev/video0`.
- Match succeeds via direct `devPath` equality on step 1.

### Two-camera machine (built-in + USB cam)

- Built-in candidate: sysfsPath under `/sys/devices/pci.../0000:00:14.0/usb.../` (or a PCI path on IPU6).
- USB cam candidate: sysfsPath under `/sys/devices/pci.../0000:00:14.0/usb2/.../`.
- Running node's parent Device sits under exactly one of those, so the prefix match selects only the active camera.
