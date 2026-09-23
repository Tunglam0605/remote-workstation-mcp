const DEFINITIONS = {
  status: { path: '/api/status', intervalMs: 15_000 },
  runtime: { path: '/api/runtime/status', intervalMs: 15_000 },
  execution: { path: '/api/execution-policy', intervalMs: 60_000 },
  antigravity: { path: '/api/antigravity/status', intervalMs: 60_000 },
  pairing: { path: '/api/devices/pairing', intervalMs: 60_000 },
  multiNode: { path: '/api/multi-node', intervalMs: 60_000 },
  permissions: { path: '/api/permissions', intervalMs: 60_000 },
  updates: { path: '/api/update/status', intervalMs: 60_000 },
  admin: { path: '/api/admin/requests', intervalMs: 15_000 }
};

const blank = () => ({ data: null, error: null, loading: false, loadedAt: null });

export function createStore(api, { consolePath } = {}) {
  const definitions = { ...DEFINITIONS };
  if (consolePath) definitions.console = { path: consolePath, intervalMs: 15_000 };
  const state = Object.fromEntries([...Object.keys(DEFINITIONS), 'console'].map((key) => [key, blank()]));
  const listeners = new Set();
  const timers = new Map();
  let started = false;

  const emit = () => listeners.forEach((listener) => listener(state));
  const set = (key, value) => { state[key] = value; emit(); };

  async function refresh(keys = Object.keys(definitions)) {
    const requested = Array.isArray(keys) ? keys : [keys];
    await Promise.all(requested.map(async (key) => {
      const definition = definitions[key];
      if (!definition || state[key].loading) return;
      set(key, { ...state[key], loading: true, error: null });
      try {
        const data = await api.request(definition.path);
        set(key, { data, error: null, loading: false, loadedAt: Date.now() });
      } catch (error) {
        set(key, { data: null, error: error instanceof Error ? error : new Error(String(error)), loading: false, loadedAt: null });
      }
    }));
  }

  function schedule(key) {
    if (!started) return;
    const definition = definitions[key];
    timers.set(key, setTimeout(async () => {
      await refresh([key]);
      schedule(key);
    }, definition.intervalMs));
  }

  function start() {
    if (started) return;
    started = true;
    for (const key of Object.keys(definitions)) {
      void refresh([key]).then(() => schedule(key));
    }
  }

  function stop() {
    started = false;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return { getState: () => state, subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback); }, refresh, start, stop };
}
