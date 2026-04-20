# Security posture

The extension runs inside the user's gnome-shell process plus one child gjs subprocess (the camera monitor). There is no network I/O, no privilege escalation, no code download. All interactions with the system are reads or writes to files the user can already open directly — `/dev/v4l-subdev*`, `/dev/video*`, and `/sys/…` — mediated by the `v4l-utils`, `udev` and `pipewire` tools that come with the OS.

## Threat model

- **Adversarial user** is *not* in the threat model. A user enabling the extension is trusting their own gnome-shell process. The worst they can achieve is changing the camera controls they could already change from a terminal.
- **Adversarial v4l2 / PipeWire devices** are in scope at the parsing level: the code that reads `v4l2-ctl --list-ctrls` output and PipeWire node properties must not crash or be coerced into misbehavior by malformed input. All parsed values are clamped, validated, or discarded.
- **Compromised subprocess** (helper, udevadm, v4l2-ctl) — covered by the subprocess isolation itself. If the helper SIGSEGVs or is replaced, the extension's supervision path turns it into an error indicator and a Retry button, never a shell crash.

## Controls

### Subprocess invocation
Every subprocess is launched through `Gio.Subprocess` with an **argv array** — never a shell command line. That completely eliminates shell injection regardless of what strings any component passes: `v4l2-ctl -c $name=$value` would be vulnerable if we built a shell string, but `['v4l2-ctl', '-c', `${name}=${value}`]` is not, because the final argv element is a single literal.

### Control name validation (`v4l2.js`)
Every control name that reaches `v4l2-ctl -c ${name}=${value}` is run through `assertControlName`, which requires it to match `/^[a-z][a-z0-9_]*$/` — the v4l2 control-name shape. Even though argv arrays already block shell injection, this blocks category-confusion (e.g. a user-supplied "control name" of `--set-ctrl=…` trying to smuggle in additional flags). The same guard applies in both `setControl` and `readControlValue`.

### Control value clamping
Every integer passed to v4l2-ctl is clamped to the discovered `[min, max]` of the control. `Number.isFinite` is asserted on every numeric value so NaN/Infinity don't leak into the argv.

### Device-path construction
The only `/dev/*` paths the extension ever constructs are `/dev/v4l-subdev${N}` and `/dev/video${N}` with N being an integer in `0..MAX_DEVICE_INDEX` (64). User input never contributes to device paths.

### Sysfs traversal (`sysfs.js`)
`acpiPathFromSysfsPath` walks *up* a sysfs path to find the nearest `firmware_node/path`. Two defensive guards: paths containing `..` are rejected, and the walker aborts the moment the working path leaves `/sys/`. File reads are through `GLib.file_get_contents`, which is byte-safe.

### Helper subprocess (`camera-monitor-helper.js`)
The only input the helper accepts is SIGTERM/SIGINT. It does not read from stdin, does not open sockets, and emits only JSON lines on stdout. Every outbound line is built by `JSON.stringify`, so PipeWire property values (even adversarial ones) can't break line framing.

### Preferences-backed allowlist (`prefs.js`)
When user preferences are wired up, the allowlist may include names typed by the user. Those still flow through `assertControlName`; names that fail the shape check are rejected at the preferences UI, and — as a belt-and-braces guard — `setControl`/`readControlValue` re-validate before spawning.

## What the extension does not do

- Does not call `sudo`, `pkexec`, or any elevation helper. If an operation requires privileges the user doesn't already have, the indicator surfaces it as an error.
- Does not write anywhere on disk outside its own settings (GSettings through dconf).
- Does not load, download, or execute code from anywhere other than the extension bundle itself and the system-provided `v4l2-ctl`/`udevadm`/`pw-*` binaries.
- Does not open sockets or network connections.
