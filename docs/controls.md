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

## What we do NOT do

- No `sudo`, `pkexec`, or setuid helper. If a `v4l2-ctl --set-ctrl` call fails with `EACCES`, we log once and surface a single notice in the menu; we never retry with elevation.
- No writes to sysfs, `/etc`, or anywhere outside what `v4l2-ctl` does.
- No `prefs.js` / GSettings schema — the extension has no persistent user-writable state.
