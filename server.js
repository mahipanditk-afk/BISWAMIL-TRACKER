// Biswamil Movement Log - small realtime server (Express + Postgres, with in-memory cache and SSE).
const express = require('express');
const fs = require('fs');
const path = require('path');

const VOL_CODE = process.env.VOL_CODE;
const HQ_CODE = process.env.HQ_CODE;
if (!VOL_CODE || !HQ_CODE) { console.error('Set VOL_CODE and HQ_CODE environment variables.'); process.exit(1); }
if (VOL_CODE === HQ_CODE) { console.error('VOL_CODE and HQ_CODE must be different.'); process.exit(1); }

const PORT = process.env.PORT || 3000;
const HQ_ONLY = new Set(['blacklist', 'config']);   // only HQ may write these
const HQ_READ = new Set(['blacklist']);              // only HQ may read these
const validColl = c => typeof c === 'string' && /^[a-z0-9_-]{1,30}$/i.test(c);
const validId = i => typeof i === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(i);

async function makeStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    await pool.query('CREATE TABLE IF NOT EXISTS docs(coll text NOT NULL, id text NOT NULL, data jsonb NOT NULL, ts bigint NOT NULL, PRIMARY KEY(coll,id))');
    const { rows } = await pool.query('SELECT coll,id,data FROM docs');
    return {
      kind: 'postgres', rows,
      upsert: (c, i, d) => pool.query('INSERT INTO docs(coll,id,data,ts) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(coll,id) DO UPDATE SET data=$3::jsonb, ts=$4', [c, i, JSON.stringify(d), Date.now()]),
      remove: (c, i) => pool.query('DELETE FROM docs WHERE coll=$1 AND id=$2', [c, i]),
    };
  }
  // Fallback for local testing only: a JSON file. On Render this is wiped on every restart.
  const file = process.env.DATA_FILE || path.join(__dirname, 'data.json');
  let rows = []; try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const mem = new Map(rows.map(r => [r.coll + '\u0000' + r.id, r]));
  let t = null;
  const save = () => { if (t) return; t = setTimeout(() => { t = null; fs.writeFile(file, JSON.stringify([...mem.values()]), () => {}); }, 500); };
  return {
    kind: 'file', rows,
    upsert: async (c, i, d) => { mem.set(c + '\u0000' + i, { coll: c, id: i, data: d }); save(); },
    remove: async (c, i) => { mem.delete(c + '\u0000' + i); save(); },
  };
}

(async () => {
  const store = await makeStore();
  const cache = new Map();                       // coll -> Map(id -> data)
  store.rows.forEach(r => { if (!cache.has(r.coll)) cache.set(r.coll, new Map()); cache.get(r.coll).set(r.id, r.data); });
  console.log('Storage:', store.kind, '| documents loaded:', store.rows.length);

  const clients = new Map();                     // coll -> Set(res)
  const broadcast = (coll, payload) => {
    const set = clients.get(coll); if (!set) return;
    const msg = 'event: ch\ndata: ' + JSON.stringify(payload) + '\n\n';
    set.forEach(res => { try { res.write(msg); } catch (e) {} });
  };
  const persist = (fn, tries = 4) => fn().catch(err => { console.error('DB write failed:', err.message); if (tries > 1) setTimeout(() => persist(fn, tries - 1), 3000); });

  const roleOf = code => code === HQ_CODE ? 'hq' : code === VOL_CODE ? 'vol' : null;

  // very small brute-force guard on the code check
  const fails = new Map();
  const blocked = ip => { const f = fails.get(ip); return f && f.n >= 20 && Date.now() - f.t < 10 * 60 * 1000; };

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '100kb' }));

  app.get('/healthz', (req, res) => res.send('ok'));

  app.get('/api/me', (req, res) => {
    if (blocked(req.ip)) return res.status(429).json({ error: 'too many tries' });
    const role = roleOf(req.get('x-code'));
    if (!role) { const f = fails.get(req.ip) || { n: 0, t: 0 }; fails.set(req.ip, { n: f.n + 1, t: Date.now() }); return res.status(401).json({ error: 'bad code' }); }
    fails.delete(req.ip); res.json({ role });
  });

  app.post('/api/set', (req, res) => {
    const role = roleOf(req.get('x-code')); if (!role) return res.status(401).end();
    const { coll, id, data } = req.body || {};
    if (!validColl(coll) || !validId(id) || !data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'bad request' });
    if (HQ_ONLY.has(coll) && role !== 'hq') return res.status(403).json({ error: 'HQ only' });
    if (!cache.has(coll)) cache.set(coll, new Map());
    cache.get(coll).set(id, data);
    persist(() => store.upsert(coll, id, data));
    broadcast(coll, { id, data });
    res.json({ ok: true });
  });

  app.post('/api/delete', (req, res) => {
    const role = roleOf(req.get('x-code')); if (!role) return res.status(401).end();
    const { coll, id } = req.body || {};
    if (!validColl(coll) || !validId(id)) return res.status(400).json({ error: 'bad request' });
    if (HQ_ONLY.has(coll) && role !== 'hq') return res.status(403).json({ error: 'HQ only' });
    if (cache.has(coll)) cache.get(coll).delete(id);
    persist(() => store.remove(coll, id));
    broadcast(coll, { id, data: null });
    res.json({ ok: true });
  });

  app.get('/api/stream', (req, res) => {
    const role = roleOf(req.query.code); if (!role) return res.status(401).end();
    const coll = req.query.coll;
    if (!validColl(coll)) return res.status(400).end();
    if (HQ_READ.has(coll) && role !== 'hq') return res.status(403).end();
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const docs = [...(cache.get(coll) || new Map())].map(([id, data]) => ({ id, data }));
    res.write('retry: 3000\nevent: snap\ndata: ' + JSON.stringify(docs) + '\n\n');
    if (!clients.has(coll)) clients.set(coll, new Set());
    clients.get(coll).add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => { clearInterval(hb); const s = clients.get(coll); if (s) s.delete(res); });
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, p) => { if (/sw\.js$|index\.html$/.test(p)) res.set('Cache-Control', 'no-cache'); },
  }));

  app.listen(PORT, () => console.log('Listening on', PORT));
})().catch(e => { console.error(e); process.exit(1); });
