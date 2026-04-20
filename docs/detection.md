# Camera-live detection

## Why WirePlumber GIR

We need to know when *any* camera client opens/closes the camera, with zero polling. On a modern Linux desktop, PipeWire is the substrate both for v4l2 and libcamera backends — so a single subscription at the PipeWire graph level covers both.

The extension uses `gir1.2-wp-0.5` (`Wp-0.5.typelib`) to import WirePlumber directly in GJS: `import Wp from 'gi://Wp'`. `Wp.Core` uses the default `GMainContext`, which is GNOME Shell's own main loop, so there's no thread or subprocess involved — PipeWire signals flow straight into JS callbacks.

## Key Wp objects

- `Wp.Core` — one per extension, owns the PipeWire client socket. `core.connect()` is async; it fires `connected` when ready.
- `Wp.ObjectManager` — scoped view over the graph. We install it with two interests:
  - `Wp.Node` filtered by `media.class = "Video/Source"` (cameras only)
  - `Wp.Device` (unfiltered; used for node → device lookup)
- `Wp.Node` — has a `state` property of enum `Wp.NodeState`: `ERROR | CREATING | SUSPENDED | IDLE | RUNNING`. Camera is "live" iff `state == RUNNING`.

## Signals we rely on

- `ObjectManager.object-added` / `object-removed` — fires per node as the graph changes.
- `Node.state-changed (node, oldState, newState)` — fires when the camera opens/closes. Requires `WP_PIPEWIRE_OBJECT_FEATURES_ALL` via `om.request_object_features`.
- `Core.disconnected` — handle daemon restart.

## GJS pitfalls (real, hit-them-if-you-dont-know)

- `Wp.init(Wp.InitFlags.ALL)` must run before anything else.
- Variadic constructors (`wp_object_interest_new`, etc.) are *not* introspectable. Use `Wp.ObjectInterest.new_type(...)` + `interest.add_constraint(...)`.
- GC hazard: keep strong JS refs to `core`, `om`, and per-node handler records on `this`. If they get collected, signals stop firing silently.
- Disconnect every handler in `disable()` and drop refs to `null`, per GNOME extension review rules.
- Use `node.get_pw_property('key')` — iterating `WpProperties` has historical GJS unboxing issues.

## Why not X

- `fuser /dev/video0` — libcamera-backed cameras (IPU6) don't route user clients through `/dev/video*`, so the device looks idle even mid-call.
- xdg-desktop-portal Camera — only fires for sandboxed/Flatpak clients.
- inotify on `/dev/video*` — open/close don't raise inotify events.
- `pw-mon` subprocess + text parsing — works but requires managing a subprocess, restart logic, and a line-based state machine for indent-sensitive output. Strictly worse than the GIR route once `gir1.2-wp-0.5` is on disk.
- `pw-dump` polling — wakes up every N seconds whether or not the graph changed; adds latency.
