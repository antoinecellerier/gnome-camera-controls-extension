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
- Only four control types are rendered:
  - **`int`** — slider with value label, debounced writes.
  - **`bool`** — switch toggle.
  - **`menu`** / **`intmenu`** — submenu with a radio-style `●` marker on the current pick.
  
  Types we explicitly don't render: `int64`, `string`, `bitmask`, `button`, `ctrl_class`. These are either not meaningfully tunable at a UI level or would need bespoke widgets.

## Reset to defaults

Each control's `default=` from `v4l2-ctl --list-ctrls-menus` is captured at enumeration time. A **Reset to defaults** menu item appears at the bottom of the control list whenever at least one non-auto-managed control holds a value different from its reported default. Clicking it drives each non-auto-managed control back to its default via the same write path as any other user interaction — so on IPU6 the same mid-stream `⌛` queuing behavior applies, and values land on the next stream start. Auto-managed (🔒) controls are skipped. Controls for which `v4l2-ctl` omitted a `default=` field are ignored by this action (rare, but possible with exotic drivers).

## Clamping & argv safety

- Slider values are clamped to the `[min, max]` reported by `v4l2-ctl --list-ctrls` before being formatted.
- `v4l2-ctl` is always invoked with a pre-built argv array via `Gio.Subprocess` — never through a shell. No user-typed or scraped string flows into argv besides the control name (which comes from `--list-ctrls` parsing) and integer value (which comes from the slider, clamped).

## Mid-stream write behavior and the "queued" state

Two quite different things happen on IPU6 with the libcamera "simple" IPA, depending on whether AGC is enabled in the IPA tuning:

- **AGC enabled (upstream default).** libcamera's auto-gain loop rewrites `exposure` and `analogue_gain` on the sensor subdev every frame. Our `v4l2-ctl -c` writes are clobbered almost immediately. No user-facing path from this extension can win that race.
- **AGC disabled** (as in `~/stuff/ipu6-camera-notes.md` — user edits `/usr/share/libcamera/ipa/simple/ov2740.yaml` to drop the `Agc:` algorithm). libcamera no longer rewrites per frame, but the sensor subdev's exposure/gain registers still refuse mid-stream `v4l2-ctl` writes: the value read back doesn't change until the stream stops. Whatever value is in place when streaming *starts* is what stays. `digital_gain` is different — it lives in software post-processing and accepts writes at any time.

The UX works around this with a "queued" state. After each slider write, the extension reads back 300 ms later via `v4l2-ctl -C`. If the value drifted (>1% of range) from what we wrote:

- The slider is **left at the user's chosen position** (not snapped back).
- The row is marked with `⌛` and a yellow tint, and a footer explains the meaning.
- The intended value is remembered.

When the camera goes idle (PipeWire `state-changed` away from RUNNING), the extension writes every slider's intended value via `setControl` — with the stream stopped, the subdev accepts the writes and they'll be in effect the next time a client opens the camera. `digital_gain` skips this queued state entirely because its writes take effect immediately.

On UVC webcams (no libcamera AE, no mid-stream refusal) every control behaves normally — the verify read-back matches, no `⌛`, no queuing.

## Detecting fully auto-managed controls (e.g. AGC-enabled IPA)

The queued flow works on an AGC-disabled IPU6 setup because flushed-on-idle values survive into the next capture. With AGC *enabled* (stock libcamera tuning) they don't — libcamera writes exposure/gain per frame and the user's flushed value is overwritten on the first frame of the next stream.

The extension detects this by keeping a per-device `lastFlushedByDev` map of values it wrote on the previous idle and, on the next live event, comparing each fresh readback to that map. If a control's fresh value is more than 1% of range off from what we flushed, it's marked **auto-managed** for this showControl cycle:

- The slider is still draggable (the row stays interactive in case the user's config changes), but it's visually **greyed out** with a 🔒 and a strikethrough on the name.
- The slider's `notify::value` handler no longer calls `setControl` for that row — writing is futile.
- The flush-on-idle path still writes *all* controls unconditionally, so the detection self-heals: if the user later disables AGC, the next live cycle's comparison will pass and the 🔒 comes off.

This turns the unactionable case (AGC enabled on IPU6) from silent failure into a visible "libcamera is driving this" marker.

Workarounds for users who need live mid-stream exposure/gain on IPU6: install Intel's `ipu6-camera-bins` + vendor IPA, or drive libcamera directly (`gst-launch-1.0 libcamerasrc ae-enable=false exposure-time=N …`) rather than going through PipeWire.

## What we do NOT do

- No `sudo`, `pkexec`, or setuid helper. If a `v4l2-ctl --set-ctrl` call fails with `EACCES`, we log once and surface a single notice in the menu; we never retry with elevation.
- No writes to sysfs, `/etc`, or anywhere outside what `v4l2-ctl` does.
- No `prefs.js` / GSettings schema — the extension has no persistent user-writable state.
