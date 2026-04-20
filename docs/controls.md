# Controls & permission model

## Allowlist

Only a curated set of v4l2 control names is exposed:

```
exposure
exposure_absolute
analogue_gain
digital_gain
gain
brightness
```

Two reasons for an allowlist rather than "show whatever is writable":

1. **Permission boundary.** We guarantee no exposed control requires elevation. The video-group-writable v4l2 controls in this list all work as a regular user on both IPU6 subdevs and UVC video nodes.
2. **Safety.** Some writable controls on IPU6 subdevs (e.g. `test_pattern`) would make the camera useless in confusing ways. Keeping a narrow list avoids that surprise.

Adding a new control means adding it to this list plus, if new hardware, updating `docs/device-mapping.md`.

## Filters

- Any control with `flags=read-only` or `flags=inactive` is dropped before the UI sees it. Read-only controls on IPU6 subdevs include `camera_orientation`, `camera_sensor_rotation`, `horizontal_blanking`, `link_frequency`, `pixel_rate`.

## Clamping & argv safety

- Slider values are clamped to the `[min, max]` reported by `v4l2-ctl --list-ctrls` before being formatted.
- `v4l2-ctl` is always invoked with a pre-built argv array via `Gio.Subprocess` — never through a shell. No user-typed or scraped string flows into argv besides the control name (which comes from `--list-ctrls` parsing) and integer value (which comes from the slider, clamped).

## libcamera override detection

On IPU6 hardware running the libcamera "simple" IPA (default on Debian/Ubuntu without Intel's proprietary `ipu6-camera-bins`), the AE/AGC loop in libcamera continuously rewrites `exposure` and `analogue_gain` on the sensor subdev while the camera is streaming. Our writes via `v4l2-ctl -c` are accepted but immediately overwritten, so the sliders *appear* broken.

To make this visible rather than silent, every slider write is verified 300 ms later via `v4l2-ctl -C`: if the read-back value doesn't match what we wrote (within 1% of range), the slider snaps back to the actual value and the row gets marked with a `⚠` and a yellow-tinted name. The mark clears as soon as the user touches the slider again.

`digital_gain` is not under libcamera's AE loop in this IPA and survives writes, which is why it's the only control that "works" end-to-end on this machine. On UVC webcams and other hardware without a libcamera AE loop, all allowlisted controls behave normally — there's nothing to override them.

Workarounds for users who need to pin exposure/gain on IPU6: install `ipu6-camera-bins` + the vendor IPA, or use a client that drives libcamera directly (e.g. `gst-launch-1.0 libcamerasrc ae-enable=false exposure-time=N`) rather than going through PipeWire.

## What we do NOT do

- No `sudo`, `pkexec`, or setuid helper. If a `v4l2-ctl --set-ctrl` call fails with `EACCES`, we log once and surface a single notice in the menu; we never retry with elevation.
- No writes to sysfs, `/etc`, or anywhere outside what `v4l2-ctl` does.
- No `prefs.js` / GSettings schema — the extension has no persistent user-writable state.
