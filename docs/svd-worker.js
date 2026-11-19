// Transport adapter: image and numerical logic lives in python/*.py.
// Pin the runtime so upstream releases cannot silently change the application.

const RUNTIME_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.8/full/pyodide.mjs';
let ready;
let session;
let requestId;

function progress(message) {
  self.postMessage({ id: requestId, type: 'progress', message });
}

async function initialize(configuration) {
  progress('Loading Python, NumPy and Pillow · first use may take a while…');
  const { loadPyodide } = await import(RUNTIME_URL);
  const pyodide = await loadPyodide();
  await pyodide.loadPackage(['numpy', 'pillow']);
  pyodide.FS.mkdirTree('/app');
  for (const name of ['svd.py', 'image_pipeline.py']) {
    const response = await fetch(new URL(`./python/${name}`, import.meta.url));
    if (!response.ok) throw new Error(`Could not load Python module ${name}.`);
    pyodide.FS.writeFile(`/app/${name}`, await response.text());
  }
  // Only interpreter setup is embedded here; application logic stays in .py.
  pyodide.runPython("import sys; sys.path.insert(0, '/app')");
  const module = pyodide.pyimport('image_pipeline');
  const limits = pyodide.toPy(configuration);
  try { session = module.CompressionSession(limits, progress); }
  finally { limits.destroy(); module.destroy(); }
  return pyodide;
}

function plainResult(proxy) {
  // toJs copies bytes out of WASM memory. Temporary proxies must be destroyed.
  try { return proxy.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false }); }
  finally { proxy.destroy(); }
}

// The UI serializes requests; IDs protect against stale replies after cancellation.
self.onmessage = async ({ data }) => {
  requestId = data.id;
  try {
    const pyodide = await (ready ??= initialize(data.limits));
    let result;
    if (data.type === 'load') {
      const bytes = pyodide.toPy(new Uint8Array(data.bytes));
      try { result = plainResult(session.load_image(bytes)); }
      finally { bytes.destroy(); }
    } else if (data.type === 'prepare') {
      result = plainResult(session.prepare(data.resolution));
    } else if (data.type === 'calculate') {
      const ranks = pyodide.toPy(data.ranks);
      try { result = plainResult(session.calculate(ranks)); }
      finally { ranks.destroy(); }
    } else throw new Error('Unknown worker request.');
    // Repeated ranks can share bytes; transfer each underlying buffer once.
    const transfers = new Set();
    if (result.png) transfers.add(result.png.buffer);
    for (const entry of [...(result.approximations ?? []), ...(result.recommendation ? [result.recommendation] : [])]) {
      transfers.add(entry.png.buffer);
    }
    self.postMessage({ id: data.id, type: 'complete', result }, [...transfers]);
  } catch (error) {
    console.error(error);
    const message = String(error.message || error).trim().split('\n').at(-1).replace(/^\w+(?:Error|Exception):\s*/, '');
    self.postMessage({ id: data.id, type: 'error', message });
  }
};
