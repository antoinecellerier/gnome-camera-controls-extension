# Architecture

## Module map

```
extension.js                  lifecycle (enable/disable)
├── prereqs.js                probe at enable; feeds error-mode state
├── cameraMonitor.js          spawns helper; parses JSON-lines; emits live/idle
│    └──► camera-monitor-helper.js   CHILD PROCESS — all Wp/PipeWire code lives here
├── v4l2.js                   v4l2-ctl wrappers: enumerate, list, set
├── sysfs.js                  udevadm-info helper; node → candidate matching
└── indicator.js              PanelMenu.Button with three modes: hidden / control / error
```

**Subprocess isolation (hard requirement):** all WirePlumber/PipeWire native code runs in the helper subprocess (`camera-monitor-helper.js`), never in gnome-shell's own process. A SIGSEGV in libpipewire/libwireplumber can only crash the helper; the shell's indicator flips into **error** mode and a **Retry** click respawns the helper. `Wp.init()` — which crashed the shell when called in-process — is only ever called inside the child.

Runtime cost on reference hardware: ~37 MB RSS, ~0% CPU at idle, <1% during a camera capture, ~200–300 ms one-time startup.

## Lifecycle

`enable()`:
1. Run prereq probe (`prereqs.js`).
2. If any prereq fails → mount indicator in **error** mode, stop here.
3. Otherwise enumerate candidate v4l2 devices (`v4l2.js`).
4. Start `cameraMonitor` (Wp.Core connect + ObjectManager install).
5. Register `camera-live` / `camera-idle` handlers that show/hide the indicator in **control** mode.

`disable()`:
1. Remove indicator from panel; drop widget refs.
2. Stop monitor: disconnect all per-node handlers, disconnect core, drop `core` and `om`.
3. Clear candidate cache.

## State machine

```
       ┌────────────┐  prereqs fail  ┌───────────┐
start→ │ probing    │ ──────────────▶│  error    │ (warning icon; Retry menu)
       └────┬───────┘                └─────┬─────┘
            │ ok                           │ Retry clicked
            ▼                              ▼
       ┌────────────┐  camera live    ┌───────────┐
       │  hidden    │ ───────────────▶│  control  │
       │  (idle)    │◀─── camera idle │  (sliders)│
       └────────────┘                  └───────────┘
```

Only one of {hidden, control, error} is visible at any time.
