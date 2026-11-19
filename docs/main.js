// The main thread owns UI state and file transport. Python owns image processing,
// numerical calculations and PNG encoding inside a persistent module worker.
import { renderSpectrum } from './spectrum.js?v=3';

// One resource configuration for the UI and Python session in the worker.
const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxSourcePixels: 32_000_000,
  maxProcessingPixels: 4_000_000,
  maxSvdDimension: 1536,
});

// Promise bridge for serialized UI requests. Termination cancels synchronous
// Python/WASM loops too; the next request creates a fresh interpreter.
class CompressionWorker {
  constructor(onProgress) {
    this.onProgress = onProgress;
    this.worker = null;
    this.pending = null;
    this.sequence = 0;
  }

  request(type, payload = {}, transfers = []) {
    if (this.pending) return Promise.reject(new Error('A calculation is already running.'));
    if (!this.worker) {
      this.worker = new Worker(new URL('./svd-worker.js', import.meta.url), { type: 'module' });
      const worker = this.worker;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.id !== this.pending?.id) return;
        if (data.type === 'progress') { this.onProgress(data.message); return; }
        const pending = this.pending;
        this.pending = null;
        if (data.type === 'complete') pending.resolve(data.result);
        else pending.reject(new Error(data.message));
      };
      worker.onerror = () => {
        if (this.worker === worker) this.reset(new Error('The Python worker failed. Check your connection, reload, or choose a lower resolution.'));
      };
      worker.onmessageerror = () => {
        if (this.worker === worker) this.reset(new Error('The worker result could not be read. Try a lower resolution.'));
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = { id, resolve, reject };
      try { this.worker.postMessage({ id, type, limits: LIMITS, ...payload }, transfers); }
      catch (error) { this.reset(error); }
    });
  }

  reset(error = new DOMException('Cancelled', 'AbortError')) {
    this.worker?.terminate();
    this.worker = null;
    this.pending?.reject(error);
    this.pending = null;
  }
}

function pngBlob(bytes) {
  return new Blob([bytes], { type: 'image/png' });
}

const fileInput = document.getElementById('inputfile');
const sourceName = document.getElementById('sourceName');
const preview = document.getElementById('imagePreview');
const resolutionSelect = document.getElementById('resolutionLimit');
const rankControls = document.getElementById('rankControls');
const rankInputs = [1, 2, 3].map(index => document.getElementById(`rank${index}`));
const rankStatus = document.getElementById('rankStatus');
const processButton = document.getElementById('processImage');
const cancelButton = document.getElementById('cancelProcessing');
const status = document.getElementById('processingStatus');
const resultsContainer = document.getElementById('results');
const supported = 'Worker' in window && location.protocol !== 'file:';
let source = null;
let prepared = null;
let previewUrl = null;
let resultUrls = [];
let busy = false;
let operation = 0;
let workerLoaded = false;
const computation = new CompressionWorker(message => setStatus(message));

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.state = error ? 'error' : 'normal';
}

// Dimensions/choices come from Python; native integer constraints give immediate
// feedback without starting a decomposition. Python validates the same ranks.
function updateControls() {
  fileInput.disabled = busy || !supported;
  resolutionSelect.disabled = busy || source === null;
  rankControls.disabled = busy || prepared === null;
  processButton.disabled = true;
  cancelButton.hidden = !busy;
  if (!prepared) { rankStatus.textContent = ''; return; }
  for (const input of rankInputs) {
    input.max = String(prepared.max_rank);
    input.setAttribute('aria-invalid', String(!input.validity.valid));
  }
  const valid = rankInputs.every(input => input.validity.valid);
  processButton.disabled = busy || !valid || !supported;
  rankStatus.textContent = valid
    ? `${prepared.width} × ${prepared.height} px · ranks 1–${prepared.max_rank}`
    : `Enter three integers between 1 and ${prepared.max_rank}.`;
}

function configureResolutions() {
  for (const choice of source.resolutions) {
    const option = [...resolutionSelect.options].find(item => item.value === choice.value);
    option.disabled = choice.disabled;
    option.textContent = `${choice.value === 'original' ? 'Original' : `Max. ${choice.value}`} · ${choice.width} × ${choice.height} px${choice.supported ? '' : ' · exceeds limit'}`;
  }
  if (resolutionSelect.selectedOptions[0].disabled) {
    resolutionSelect.value = source.resolutions.find(item => item.value === 'original' && !item.disabled) ? 'original' : '512';
  }
}

function clearResults() {
  for (const url of resultUrls) URL.revokeObjectURL(url);
  resultUrls = [];
  resultsContainer.replaceChildren();
  document.getElementById('spectrum').replaceChildren();
  document.getElementById('spectrumSection').hidden = true;
}

function clearPrepared() {
  prepared = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.removeAttribute('src');
  preview.hidden = true;
}

// A cancelled/crashed interpreter loses its in-memory source and factors. Keep
// the browser File so a later request can restore them without asking for upload.
async function ensureSourceLoaded(current) {
  if (!workerLoaded) {
    const bytes = await source.file.arrayBuffer();
    if (current !== operation) throw new DOMException('Cancelled', 'AbortError');
    await computation.request('load', { bytes }, [bytes]);
    if (current !== operation) throw new DOMException('Cancelled', 'AbortError');
    workerLoaded = true;
  }
}

async function prepareCurrentImage() {
  if (!source || busy) return;
  const current = ++operation;
  clearResults();
  clearPrepared();
  busy = true;
  updateControls();
  setStatus('Preparing the grayscale image in Python…');
  try {
    await ensureSourceLoaded(current);
    if (current !== operation) return;
    const image = await computation.request('prepare', { resolution: resolutionSelect.value });
    if (current !== operation) return;
    image.referenceBlob = pngBlob(image.png);
    delete image.png;
    prepared = image;
    previewUrl = URL.createObjectURL(image.referenceBlob);
    preview.src = previewUrl;
    preview.hidden = false;
    setStatus('Image ready.');
  } catch (error) {
    if (current === operation && error.name !== 'AbortError') {
      workerLoaded = false;
      computation.reset();
      setStatus(error.message, true);
    }
  } finally {
    if (current === operation) { busy = false; updateControls(); }
  }
}

async function selectImage(file) {
  const current = ++operation;
  clearResults();
  clearPrepared();
  source = null;
  workerLoaded = false;
  sourceName.textContent = '';
  busy = true;
  updateControls();
  setStatus('Reading image in Python…');
  try {
    if (!file.size || file.size > LIMITS.maxFileBytes) {
      throw new Error('Choose a nonempty image of at most 20 MiB.');
    }
    const bytes = await file.arrayBuffer();
    if (current !== operation) return;
    const metadata = await computation.request('load', { bytes }, [bytes]);
    if (current !== operation) return;
    source = { ...metadata, file, name: file.name };
    workerLoaded = true;
    sourceName.textContent = `${source.name} · ${source.width} × ${source.height} px`;
    sourceName.title = sourceName.textContent;
    configureResolutions();
    busy = false;
    await prepareCurrentImage();
  } catch (error) {
    if (current === operation && error.name !== 'AbortError') {
      computation.reset();
      setStatus(error.message, true);
      busy = false;
      updateControls();
    }
  }
}

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) selectImage(fileInput.files[0]);
});

resolutionSelect.addEventListener('change', prepareCurrentImage);
for (const input of rankInputs) input.addEventListener('input', () => {
  clearResults();
  setStatus('Settings changed. Generate to update the results.');
  updateControls();
});

processButton.addEventListener('click', async () => {
  if (busy || !prepared) return;
  const invalid = rankInputs.find(input => !input.checkValidity());
  if (invalid) { invalid.reportValidity(); updateControls(); return; }
  const current = ++operation;
  const image = prepared;
  const start = performance.now();
  clearResults();
  busy = true;
  updateControls();
  setStatus('Starting the Python calculation…');
  try {
    if (!workerLoaded) {
      await ensureSourceLoaded(current);
      if (current !== operation) return;
      // Restore the same prepared matrix after terminating a previous worker.
      await computation.request('prepare', { resolution: resolutionSelect.value });
    }
    const result = await computation.request('calculate', { ranks: rankInputs.map(input => input.valueAsNumber) });
    if (current !== operation) return;
    for (const entry of [...result.approximations, result.recommendation]) {
      entry.blob = pngBlob(entry.png);
      delete entry.png;
    }
    renderResults(result, image);
    renderSpectrum(result);
    setStatus(`Done in ${((performance.now() - start) / 1000).toFixed(2)} s${result.svd_cached ? ' · SVD reused' : ''}. Four PNG downloads are ready.`);
  } catch (error) {
    if (current === operation && error.name !== 'AbortError') {
      workerLoaded = false;
      computation.reset();
      clearResults();
      setStatus(error.message, true);
    }
  } finally {
    if (current === operation) { busy = false; updateControls(); }
  }
});

cancelButton.addEventListener('click', () => {
  ++operation;
  computation.reset();
  workerLoaded = false;
  busy = false;
  clearResults();
  setStatus('Cancelled. Python will restart on the next request.');
  updateControls();
});

function addMetric(list, label, value, className = '') {
  const row = document.createElement('div');
  row.className = `metric-row ${className}`;
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  row.append(term, description);
  list.append(row);
  return row;
}

function renderResults(result, image) {
  const referenceBytes = image.referenceBlob.size;
  const entries = [{ title: 'Grayscale reference', blob: image.referenceBlob },
    ...result.approximations.map((entry, index) => ({ ...entry, title: `Rank ${entry.rank}`, index })),
    { ...result.recommendation, title: `Recommended · rank ${result.recommendation.rank}`, recommended: true }];
  const figures = entries.map(entry => {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    const heading = document.createElement('h2');
    heading.textContent = entry.title;
    caption.append(heading);
    const url = URL.createObjectURL(entry.blob);
    resultUrls.push(url);
    const picture = document.createElement('img');
    picture.src = url;
    picture.alt = `${entry.title} of ${source.name}`;
    figure.append(caption, picture);
    const metrics = document.createElement('dl');
    metrics.className = 'image-metrics';
    if (entry.rank === undefined) {
      addMetric(metrics, 'Resolution', `${image.width} × ${image.height} px`);
    } else {
      addMetric(metrics, 'Relative error', `${(entry.relative_error * 100).toFixed(2)}%`);
    }
    addMetric(metrics, 'PNG size', `${entry.blob.size.toLocaleString('en-US')} bytes`);
    if (entry.rank !== undefined) {
      const difference = referenceBytes - entry.blob.size;
      const percentage = (Math.abs(difference) / referenceBytes * 100).toFixed(2);
      addMetric(metrics, 'PNG file savings', difference === 0 ? 'Same size' : `${percentage}% ${difference > 0 ? 'smaller' : 'larger'}`, difference < 0 ? 'size-increase' : '').title = 'Actual PNG bytes compared with the processed grayscale reference PNG.';
      const savings = entry.svd_value_savings;
      addMetric(metrics, 'SVD value savings', savings === 0 ? 'Same count' : `${(Math.abs(savings) * 100).toFixed(2)}% ${savings > 0 ? 'fewer' : 'more'}`, savings < 0 ? 'size-increase' : '').title = 'Theoretical scalar counts: k × (height + width + 1) vs. height × width. Assumes equal bytes per value; excludes encoding and overhead.';
      if (entry.numerical_components < entry.rank) addMetric(metrics, 'Significant terms', String(entry.numerical_components));
      if (entry.recommended) addMetric(metrics, 'Error limit', '5%');
    }
    figure.append(metrics);
    if (entry.rank !== undefined) {
      const link = document.createElement('a');
      link.href = url;
      link.download = `svd-${entry.recommended ? 'recommended' : `approximation-${entry.index + 1}`}-rank-${entry.rank}-${image.width}x${image.height}.png`;
      link.textContent = 'Download PNG';
      figure.append(link);
    }
    return figure;
  });
  resultsContainer.replaceChildren(...figures);
}

// Static hosting works at repository subpaths; file:// cannot load this worker.
if (location.protocol === 'file:') setStatus('Open this app through GitHub Pages or a local HTTP server.', true);
else if (!('Worker' in window)) setStatus('This browser does not support Web Workers. Try a current browser.', true);
else setStatus('Choose an image.');
updateControls();
