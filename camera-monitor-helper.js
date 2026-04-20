#!/usr/bin/gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Standalone helper: runs all WirePlumber/PipeWire code in a child process so
// a native crash here CANNOT take down gnome-shell. Speaks JSON-lines on stdout.
//
// Events written to stdout, one JSON object per line, always with a `type`:
//   {"type":"ready"}                       // Wp.Core connected, initial enumeration done
//   {"type":"live", bound_id, description, api_v4l2_path, device:{api, api_libcamera_path, bus_path}}
//   {"type":"idle"}
//   {"type":"fatal", reason}               // unrecoverable — process will exit shortly
//
// Reads nothing from stdin. On SIGTERM/SIGINT the main loop quits cleanly.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Wp from 'gi://Wp?version=0.5';

const onSignal = (obj, signal, cb) =>
    GObject.Object.prototype.connect.call(obj, signal, cb);

const emit = (obj) => {
    try {
        print(JSON.stringify(obj));
    } catch (e) {
        // If JSON fails, at minimum try to note it
        printerr(`helper emit failed: ${e.message}`);
    }
};

const fatalExit = (reason) => {
    try { emit({type: 'fatal', reason}); } catch {}
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        globalThis._loop?.quit();
        return GLib.SOURCE_REMOVE;
    });
};

// Catch any top-level throw to at least report it before dying.
try {
    Wp.init(Wp.InitFlags.ALL);
} catch (e) {
    fatalExit(`Wp.init failed: ${e.message}`);
    throw e;
}

const loop = GLib.MainLoop.new(null, false);
globalThis._loop = loop;

const core = Wp.Core.new(null, null, null);
const om = Wp.ObjectManager.new();

const nodeInterest = Wp.ObjectInterest.new_type(Wp.Node.$gtype);
nodeInterest.add_constraint(
    Wp.ConstraintType.PW_PROPERTY,
    'media.class',
    Wp.ConstraintVerb.EQUALS,
    GLib.Variant.new_string('Video/Source'),
);
om.add_interest_full(nodeInterest);
om.add_interest_full(Wp.ObjectInterest.new_type(Wp.Device.$gtype));
om.request_object_features(Wp.Node.$gtype, Wp.OBJECT_FEATURES_ALL);
om.request_object_features(Wp.Device.$gtype, Wp.OBJECT_FEATURES_ALL);

const getProp = (obj, key) => {
    try { return obj?.get_properties?.()?.get(key) ?? null; }
    catch { return null; }
};

const findDeviceByBoundId = (id) => {
    if (!Number.isFinite(id)) return null;
    try {
        const interest = Wp.ObjectInterest.new_type(Wp.Device.$gtype);
        interest.add_constraint(
            Wp.ConstraintType.G_PROPERTY,
            'bound-id',
            Wp.ConstraintVerb.EQUALS,
            GLib.Variant.new_uint32(id),
        );
        return om.lookup_full(interest);
    } catch {
        return null;
    }
};

const nodes = new Map();
let liveNode = null;

const snapshot = (node) => {
    const deviceIdStr = getProp(node, 'device.id');
    const device = deviceIdStr ? findDeviceByBoundId(parseInt(deviceIdStr, 10)) : null;
    return {
        bound_id: parseInt(getProp(node, 'object.id') ?? deviceIdStr ?? '0', 10) || null,
        description: getProp(node, 'node.description') ?? getProp(node, 'node.name') ?? 'Camera',
        api_v4l2_path: getProp(node, 'api.v4l2.path'),
        device: device ? {
            api: getProp(device, 'device.api'),
            api_libcamera_path: getProp(device, 'api.libcamera.path'),
            bus_path: getProp(device, 'device.bus-path'),
        } : null,
    };
};

const onStateChanged = (node, _old, newS) => {
    try {
        if (newS === Wp.NodeState.RUNNING) {
            if (liveNode !== node) {
                liveNode = node;
                emit({type: 'live', ...snapshot(node)});
            }
        } else if (liveNode === node) {
            liveNode = null;
            emit({type: 'idle'});
        }
    } catch (e) {
        printerr(`onStateChanged: ${e.message}`);
    }
};

om.connect('object-added', (_o, obj) => {
    try {
        if (!(obj instanceof Wp.Node)) return;
        const handler = obj.connect('state-changed', onStateChanged);
        nodes.set(obj, handler);
        if (obj.state === Wp.NodeState.RUNNING)
            onStateChanged(obj, Wp.NodeState.IDLE, Wp.NodeState.RUNNING);
    } catch (e) {
        printerr(`object-added: ${e.message}`);
    }
});

om.connect('object-removed', (_o, obj) => {
    try {
        const h = nodes.get(obj);
        if (h === undefined) return;
        try { obj.disconnect(h); } catch {}
        nodes.delete(obj);
        if (liveNode === obj) {
            liveNode = null;
            emit({type: 'idle'});
        }
    } catch (e) {
        printerr(`object-removed: ${e.message}`);
    }
});

let readyEmitted = false;
onSignal(core, 'connected', () => {
    if (!readyEmitted) {
        readyEmitted = true;
        emit({type: 'ready'});
    }
});

onSignal(core, 'disconnected', () => {
    emit({type: 'fatal', reason: 'pipewire disconnected'});
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
});

try {
    core.install_object_manager(om);
    if (!core.connect())
        fatalExit('core.connect() returned false');
} catch (e) {
    fatalExit(`install/connect threw: ${e.message}`);
}

// Startup watchdog: if we never get 'connected' within 5s, fail loudly.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    if (!readyEmitted) fatalExit('connect timeout');
    return GLib.SOURCE_REMOVE;
});

// Clean shutdown on parent's SIGTERM/SIGINT.
const SIGINT = 2;
const SIGTERM = 15;
for (const sig of [SIGINT, SIGTERM]) {
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}

loop.run();

// Defer disconnect to idle to avoid SIGSEGV inside libpipewire on some paths.
if (core.is_connected()) {
    try { core.disconnect(); } catch {}
}
