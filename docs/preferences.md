# Preferences — user-configurable allowlist

## Why this exists

Early iterations hard-coded the set of v4l2 control names the extension would render as sliders (`exposure`, `analogue_gain`, `digital_gain`, `gain`, `brightness`, `exposure_absolute`). That set covers the common brightness/exposure case but leaves out plenty of legitimate controls (`white_balance_temperature`, `saturation`, `hue`, vendor-specific entries), and there's no way to know in advance which ones a given camera exposes. Preferences let users extend the list without editing JS.

## Storage — GSettings schema

Schema id: `org.gnome.shell.extensions.camera-controls`, path `/org/gnome/shell/extensions/camera-controls/`.

Single key: `allowed-controls` — `as` (array of strings). Default list matches the six names used in earlier commits. Set via `settings-schema` in `metadata.json`; `this.getSettings()` in `extension.js` fetches the bound `Gio.Settings`.

The extension listens for `changed::allowed-controls` and invalidates its cached candidate list, so preference changes take effect on the next `live` event without re-enabling the extension.

## UI — `prefs.js`

Built with libadwaita (`Adw.PreferencesPage` / `Adw.PreferencesGroup` / `Adw.SwitchRow`). Two groups:

- **Detected controls** — every writable integer control found on any `/dev/v4l-subdev*` or `/dev/video*` present at the moment the prefs window is opened. Each control gets a switch row; its subtitle says whether it's currently detected or just lingering in the allowlist from a previous session.
- **Custom allowlist entries** — a single `Adw.ActionRow` with a `Gtk.Entry` for typing a control name plus an **Add** button. On add, the entry is validated against `CONTROL_NAME_RE` (`/^[a-z][a-z0-9_]*$/`); if it fails, the entry gets GTK's `error` CSS class. If it passes, the name is added to `allowed-controls` and a matching switch row appears inline so the user sees the change take effect.

Enumeration uses `enumerateAllWritableControls()` from `v4l2.js`, which scans every candidate device and returns a sorted unique list, bypassing the allowlist entirely (otherwise the prefs UI would only ever show what's already allowed — a bootstrapping problem).

## Validation — defense in depth

Control names are validated at three layers:

1. **Prefs UI** — reject invalid shapes before writing to GSettings (visible error state).
2. **`v4l2.js::assertControlName`** — every `setControl` / `readControlValue` call revalidates, so even if GSettings somehow contains a bad name (dconf edit, older version, etc.) the runtime refuses to spawn `v4l2-ctl` with it.
3. **Gio.Subprocess argv** — the control name ends up as a single argv element (`name=value`), not a shell fragment, so even a hypothetically-malicious name can only produce a bad v4l2-ctl argument, not shell injection.

## What is *not* configurable from prefs

- The device paths (`/dev/v4l-subdev*`, `/dev/video*`) — still enumerated.
- The matching rules from PipeWire Node → v4l2 device — code-only.
- Debounce / verify timings — code-only.

All of those could become settings later if the need arises; for v1 they're intentionally kept out of the UI to minimize the options surface.
