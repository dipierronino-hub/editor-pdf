// Editor PDF — funzionamento offline e ricezione dei PDF condivisi da altre app.
const CACHE = 'editor-pdf-shell-v1';
const CONDIVISI = 'editor-pdf-condivisi';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs', 'lib/pdf-lib.min.js'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== CONDIVISI).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // PDF condiviso da un'altra app (es. WhatsApp): lo metto da parte e apro l'editor
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const data = await e.request.formData(), c = await caches.open(CONDIVISI);
        for (const k of await c.keys()) await c.delete(k);
        let i = 0;
        for (const f of data.getAll('file')) {
          if (!f || !f.size) continue;
          await c.put('condiviso-' + (i++), new Response(f, { headers: { 'content-type': 'application/pdf', 'x-nome': encodeURIComponent(f.name || 'documento.pdf') } }));
        }
      } catch (err) { /* si apre comunque l'editor */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET') return;

  // librerie: prima la copia salvata; il resto: prima la rete, così gli aggiornamenti arrivano subito
  const libreria = url.pathname.includes('/lib/');
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (libreria) { const hit = await c.match(e.request, { ignoreSearch: true }); if (hit) return hit; }
    try {
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true }) || (e.request.mode === 'navigate' ? await c.match('./') : null);
      if (hit) return hit; throw err;
    }
  })());
});
