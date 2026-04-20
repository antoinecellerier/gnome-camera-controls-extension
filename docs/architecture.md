# Architecture

## Module map

```
extension.js           lifecycle (enable/disable)
├── prereqs.js         probe at enable; feeds error-mode state
├── cameraMonitor.js   Wp.Core + ObjectManager; emits live/idle with active Wp.Node
├── v4l2.js            v4l2-ctl wrappers: enumerate, list, set
├── sysfs.js           udevadm-info helper; node → candidate matching
└── indicator.js       PanelMenu.Button with three modes: hidden / control / error
```

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
