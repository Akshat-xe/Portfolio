// Feedback capture.
//
// By design there is no hard-coded endpoint: reports are queued in
// localStorage and go nowhere until you supply a URL of your own in the
// Feedback tab. Nothing leaves the browser without an explicit endpoint and an
// explicit submit.

const QUEUE_KEY = 'akshat-racing-engine/feedback/v1';

export function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function writeQueue(list) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-200))); }
  catch { /* private mode */ }
}

export function buildReport(fields, engineState) {
  return {
    id: 'fb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    at: new Date().toISOString(),
    category: fields.category,
    message: fields.message,
    contact: fields.contact || null,
    engine: {
      version: engineState.version,
      seed: engineState.seed,
      odometer: Math.round(engineState.odometer),
      fps: Math.round(engineState.fps),
      renderer: engineState.renderer,
      viewport: engineState.viewport,
      settings: engineState.settings,
    },
    agent: navigator.userAgent,
  };
}

// A bare Formspree form ID expands to its endpoint. Anything containing a
// scheme is used verbatim, so any collector works.
export function resolveEndpoint(value) {
  const v = (value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^[a-z0-9]{6,}$/i.test(v)) return 'https://formspree.io/f/' + v;
  return null;
}

// Submitting to Formspree is a JSON POST with an Accept header asking for a
// JSON reply instead of a redirect — the same request @formspree/ajax makes,
// without taking on the dependency.
export async function submit(report, endpointValue) {
  const queue = readQueue();
  const endpoint = resolveEndpoint(endpointValue);

  if (!endpoint) {
    queue.push({ ...report, delivered: false });
    writeQueue(queue);
    return { ok: true, delivered: false, queued: queue.length };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(flatten(report)),
  });

  if (!res.ok) {
    // Formspree reports validation problems in the body rather than the status
    // text, so surface those instead of a bare 4xx.
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && Array.isArray(body.errors) && body.errors.length) {
        detail = body.errors.map((e) => e.message).join('; ');
      }
    } catch { /* non-JSON error body */ }
    throw new Error('HTTP ' + res.status + ' — ' + detail);
  }

  queue.push({ ...report, delivered: true });
  writeQueue(queue);
  return { ok: true, delivered: true, queued: queue.length };
}

// Collectors generally expect flat scalar fields, so the engine block is
// stringified rather than nested.
function flatten(report) {
  return {
    id: report.id,
    at: report.at,
    category: report.category,
    message: report.message,
    email: report.contact || '',
    _subject: `[Akshat Racing Engine] ${report.category}`,
    seed: report.engine.seed,
    version: report.engine.version,
    odometer_m: report.engine.odometer,
    fps: report.engine.fps,
    renderer: report.engine.renderer,
    viewport: report.engine.viewport,
    settings: JSON.stringify(report.engine.settings),
    agent: report.agent,
  };
}

export function exportQueue() {
  const blob = new Blob([JSON.stringify(readQueue(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'akshat-racing-engine-feedback.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function clearQueue() {
  try { localStorage.removeItem(QUEUE_KEY); } catch { /* ignore */ }
}
