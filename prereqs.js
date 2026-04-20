import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const onSignal = (obj, signal, cb) =>
    GObject.Object.prototype.connect.call(obj, signal, cb);

async function loadWp() {
    try {
        const mod = await import('gi://Wp?version=0.5');
        return mod.default;
    } catch {
        return null;
    }
}

async function checkWpTypelib() {
    if (await loadWp()) return null;
    return {
        id: 'wp-typelib',
        label: 'WirePlumber GIR typelib missing',
        explanation: 'Needed for event-driven camera detection.',
        fixCommand: 'sudo apt install gir1.2-wp-0.5',
        blocking: true,
    };
}

function checkProgram({name, label, explanation, fixCommand, blocking = true}) {
    if (GLib.find_program_in_path(name)) return null;
    return {id: `bin-${name}`, label, explanation, fixCommand, blocking};
}

async function checkPipeWire(Wp) {
    if (!Wp) return null;
    try {
        Wp.init(Wp.InitFlags.ALL);
    } catch {
        // already initialized — fine
    }
    const core = Wp.Core.new(null, null, null);
    const failure = {
        id: 'pipewire',
        label: 'Cannot reach PipeWire',
        explanation: 'The PipeWire daemon did not accept a connection for this session.',
        fixCommand: 'systemctl --user restart pipewire wireplumber',
        blocking: true,
    };
    return new Promise((resolve) => {
        let settled = false;
        let timeoutId = 0;
        const settle = (ok) => {
            if (settled) return;
            settled = true;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            // Defer disconnect to an idle callback — calling it synchronously
            // from inside the 'connected' handler can SIGSEGV inside libpipewire.
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (core.is_connected()) {
                    try { core.disconnect(); } catch {}
                }
                return GLib.SOURCE_REMOVE;
            });
            resolve(ok ? null : failure);
        };
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            timeoutId = 0;
            settle(false);
            return GLib.SOURCE_REMOVE;
        });
        onSignal(core, 'connected', () => settle(true));
        onSignal(core, 'disconnected', () => {
            if (!settled) settle(false);
        });
        if (!core.connect()) settle(false);
    });
}

export async function probe() {
    const failures = [];
    const push = (f) => { if (f) failures.push(f); };

    push(await checkWpTypelib());
    push(checkProgram({
        name: 'v4l2-ctl',
        label: 'v4l2-ctl not on PATH',
        explanation: 'Needed to read and write camera controls.',
        fixCommand: 'sudo apt install v4l-utils',
    }));
    push(checkProgram({
        name: 'udevadm',
        label: 'udevadm not on PATH',
        explanation: 'Needed to map the active libcamera node to its v4l2 control device.',
        fixCommand: 'sudo apt install udev',
        blocking: false,
    }));

    const hasTypelib = !failures.some(f => f.id === 'wp-typelib');
    if (hasTypelib) {
        const Wp = await loadWp();
        push(await checkPipeWire(Wp));
    }

    return {
        ok: failures.every(f => !f.blocking),
        failures,
    };
}
