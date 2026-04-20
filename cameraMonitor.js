import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

const onSignal = (obj, signal, cb) =>
    GObject.Object.prototype.connect.call(obj, signal, cb);
const offSignal = (obj, id) =>
    GObject.Object.prototype.disconnect.call(obj, id);

export class CameraMonitor {
    constructor() {
        this._Wp = null;
        this._core = null;
        this._om = null;
        this._coreHandlers = [];
        this._omHandlers = [];
        this._nodes = new Map();
        this._listeners = {live: [], idle: []};
        this._liveNode = null;
    }

    async start() {
        const mod = await import('gi://Wp?version=0.5');
        this._Wp = mod.default;
        const Wp = this._Wp;
        try { Wp.init(Wp.InitFlags.ALL); } catch {}

        this._core = Wp.Core.new(null, null, null);

        const om = Wp.ObjectManager.new();
        this._om = om;

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

        this._omHandlers.push(
            om.connect('object-added', (_o, obj) => this._onObjectAdded(obj)),
            om.connect('object-removed', (_o, obj) => this._onObjectRemoved(obj)),
        );

        this._coreHandlers.push(
            onSignal(this._core, 'disconnected', () => this._onDisconnected()),
        );

        this._core.install_object_manager(om);

        await this._waitConnected();
    }

    _waitConnected() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (ok, reason) => {
                if (settled) return;
                settled = true;
                if (ok) resolve();
                else reject(new Error(`Wp.Core connection failed: ${reason}`));
            };
            this._coreHandlers.push(
                onSignal(this._core, 'connected', () => settle(true)),
            );
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                settle(false, 'timeout');
                return GLib.SOURCE_REMOVE;
            });
            if (!this._core.connect()) settle(false, 'connect() returned false');
        });
    }

    stop() {
        for (const [node, record] of this._nodes) {
            if (record?.stateHandler) {
                try { node.disconnect(record.stateHandler); } catch {}
            }
        }
        this._nodes.clear();

        if (this._om) {
            for (const id of this._omHandlers) {
                try { this._om.disconnect(id); } catch {}
            }
            this._omHandlers = [];
        }

        if (this._core) {
            for (const id of this._coreHandlers) {
                try { offSignal(this._core, id); } catch {}
            }
            this._coreHandlers = [];

            const core = this._core;
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (core.is_connected()) {
                    try { core.disconnect(); } catch {}
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        this._core = null;
        this._om = null;
        this._liveNode = null;
        this._Wp = null;
    }

    on(event, cb) {
        if (!this._listeners[event]) throw new Error(`Unknown event: ${event}`);
        this._listeners[event].push(cb);
    }

    _emit(event, ...args) {
        for (const cb of this._listeners[event]) {
            try { cb(...args); } catch (e) { logError?.(e); }
        }
    }

    _onObjectAdded(obj) {
        const Wp = this._Wp;
        if (!(obj instanceof Wp.Node)) return;
        const handler = obj.connect('state-changed', (_n, oldState, newState) => {
            this._onNodeStateChanged(obj, oldState, newState);
        });
        this._nodes.set(obj, {stateHandler: handler});
        if (obj.state === Wp.NodeState.RUNNING)
            this._onNodeStateChanged(obj, Wp.NodeState.IDLE, Wp.NodeState.RUNNING);
    }

    _onObjectRemoved(obj) {
        const record = this._nodes.get(obj);
        if (!record) return;
        try { obj.disconnect(record.stateHandler); } catch {}
        this._nodes.delete(obj);
        if (this._liveNode === obj) {
            this._liveNode = null;
            this._emit('idle');
        }
    }

    _onNodeStateChanged(node, oldState, newState) {
        const Wp = this._Wp;
        if (newState === Wp.NodeState.RUNNING) {
            if (this._liveNode !== node) {
                this._liveNode = node;
                this._emit('live', node);
            }
        } else if (this._liveNode === node) {
            this._liveNode = null;
            this._emit('idle');
        }
    }

    _onDisconnected() {
        if (this._liveNode) {
            this._liveNode = null;
            this._emit('idle');
        }
    }

    getLiveNode() {
        return this._liveNode;
    }

    static getProp(obj, key) {
        return obj.get_properties?.()?.get(key) ?? null;
    }

    findDeviceByBoundId(boundId) {
        if (!this._om || !this._Wp) return null;
        const Wp = this._Wp;
        const interest = Wp.ObjectInterest.new_type(Wp.Device.$gtype);
        interest.add_constraint(
            Wp.ConstraintType.G_PROPERTY,
            'bound-id',
            Wp.ConstraintVerb.EQUALS,
            GLib.Variant.new_uint32(boundId),
        );
        return this._om.lookup_full(interest) ?? null;
    }
}
