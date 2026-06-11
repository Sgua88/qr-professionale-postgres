const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cron = require('node-cron');
const { Pool } = require('pg');
const initSqlJs = require('sql.js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const AUTH_USER = process.env.AUTH_USER || 'rasisnc';
const AUTH_PASS = process.env.AUTH_PASS || 'Gianluca1';
const AUTH_SECRET = process.env.AUTH_SECRET || process.env.COOKIE_SECRET || 'qr-manager-change-this-secret';
const SQLITE_SEED_PATH = path.join(__dirname, 'data', 'qrcode.db');

if (!DATABASE_URL) {
  console.error('ERRORE: DATABASE_URL mancante. Configura PostgreSQL e imposta DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' || DATABASE_URL.includes('localhost') || DATABASE_URL.includes('postgres:5432')
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/jsQR.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, part) => {
    const i = part.indexOf('=');
    if (i > -1) acc[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    return acc;
  }, {});
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.user || !payload.exp || Date.now() > payload.exp) return null;
    if (payload.user !== AUTH_USER) return null;
    return payload;
  } catch {
    return null;
  }
}

function getAuth(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies.qr_session);
}

function requireAuth(req, res, next) {
  if (getAuth(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non autenticato' });
  return res.redirect('/login');
}

function setSessionCookie(res, remember) {
  const durationMs = remember ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60 * 12;
  const token = signToken({ user: AUTH_USER, exp: Date.now() + durationMs });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = remember ? `; Max-Age=${60 * 60 * 24 * 30}` : '';
  res.setHeader('Set-Cookie', `qr_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax${secure}${maxAge}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `qr_session=; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=0`);
}

app.get('/login', (req, res) => {
  if (getAuth(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  if (username === AUTH_USER && password === AUTH_PASS) {
    setSessionCookie(res, !!remember);
    return res.json({ success: true, user: AUTH_USER });
  }
  return res.status(401).json({ success: false, error: 'Credenziali non corrette' });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: AUTH_USER });
});

app.use('/api', requireAuth);
app.use('/download-db', requireAuth);



const DEFAULT_SYNC_CONFIG = {
  batchSize: Number(process.env.SYNC_BATCH_SIZE || 25),
  delayMs: Number(process.env.SYNC_DELAY_MS || 1800),
  cacheHours: Number(process.env.SYNC_CACHE_HOURS || 12),
  maxRetries: Number(process.env.SYNC_MAX_RETRIES || 2)
};

let syncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  checked: 0,
  updated: 0,
  skipped: 0,
  cached: 0,
  errors: 0,
  currentIndex: 0,
  currentMatricola: '',
  lastMessage: 'Pronto.',
  lastSamples: [],
  stopRequested: false,
  config: DEFAULT_SYNC_CONFIG
};

function nowIso() { return new Date().toISOString(); }
function nowIt() { return new Date().toLocaleString('it-IT'); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function publicSyncState() {
  const percent = syncState.total ? Math.round(syncState.checked / syncState.total * 100) : 0;
  return { ...syncState, percent };
}
function addSample(sample) {
  syncState.lastSamples.unshift(sample);
  syncState.lastSamples = syncState.lastSamples.slice(0, 10);
}
async function saveSyncState() {
  await pool.query(`
    INSERT INTO app_state(key, value) VALUES('syncState', $1)
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [JSON.stringify(syncState)]);
}
async function loadSyncState() {
  const r = await pool.query(`SELECT value FROM app_state WHERE key='syncState'`);
  if (r.rows[0]) syncState = { ...syncState, ...r.rows[0].value, running: false, stopRequested: false };
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id BIGSERIAL PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      last_checked TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS results (
      matricola TEXT PRIMARY KEY,
      url_id BIGINT REFERENCES urls(id) ON DELETE SET NULL,
      stato TEXT,
      ultima_vp TEXT,
      data_vp TEXT,
      risultato_vp TEXT,
      partita_iva_vp TEXT,
      cf_tecnico TEXT,
      ultima_trasmissione TEXT,
      versione_fw TEXT,
      partita_iva TEXT,
      denominazione TEXT,
      link_qr TEXT,
      last_sync TIMESTAMPTZ,
      sync_error TEXT,
      sync_attempts INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_results_matricola ON results(matricola);
    CREATE INDEX IF NOT EXISTS idx_results_piva ON results(partita_iva);
    CREATE INDEX IF NOT EXISTS idx_results_data_vp ON results(data_vp);
    CREATE INDEX IF NOT EXISTS idx_results_last_sync ON results(last_sync);

    CREATE TABLE IF NOT EXISTS ae_cache (
      url TEXT PRIMARY KEY,
      saved_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS schedule_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN DEFAULT false,
      frequency TEXT DEFAULT 'daily',
      time TEXT DEFAULT '01:00',
      day_of_week TEXT DEFAULT '1',
      day_of_month TEXT DEFAULT '1',
      batch_size INTEGER DEFAULT 25,
      delay_ms INTEGER DEFAULT 1800,
      cache_hours INTEGER DEFAULT 12,
      max_retries INTEGER DEFAULT 2,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT one_schedule CHECK (id = 1)
    );

    INSERT INTO schedule_config(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
  `);
}

async function seedFromSqliteIfEmpty() {
  const count = await pool.query(`SELECT COUNT(*)::int AS c FROM results`);
  if (count.rows[0].c > 0) return;
  if (!fs.existsSync(SQLITE_SEED_PATH)) return;

  console.log('Import iniziale da qrcode.db verso PostgreSQL...');
  const SQL = await initSqlJs({ locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file) });
  const sqlite = new SQL.Database(fs.readFileSync(SQLITE_SEED_PATH));

  const urlRows = [];
  const urlExec = sqlite.exec(`SELECT rowid AS old_id, url, last_checked FROM urls`);
  if (urlExec[0]) {
    const cols = urlExec[0].columns;
    for (const values of urlExec[0].values) urlRows.push(Object.fromEntries(cols.map((c, i) => [c, values[i]])));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldToNew = new Map();
    for (const u of urlRows) {
      const r = await client.query(
        `INSERT INTO urls(url,last_checked) VALUES($1, NULLIF($2,'')::timestamptz)
         ON CONFLICT(url) DO UPDATE SET url=EXCLUDED.url
         RETURNING id`,
        [u.url, u.last_checked || null]
      );
      oldToNew.set(Number(u.old_id), r.rows[0].id);
    }

    const resExec = sqlite.exec(`SELECT * FROM results`);
    if (resExec[0]) {
      const cols = resExec[0].columns;
      for (const values of resExec[0].values) {
        const row = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
        const urlId = oldToNew.get(Number(row.url_id)) || null;
        const link = urlRows.find(u => Number(u.old_id) === Number(row.url_id))?.url || null;
        await client.query(`
          INSERT INTO results(
            matricola, url_id, stato, ultima_vp, data_vp, risultato_vp,
            partita_iva_vp, ultima_trasmissione, versione_fw, partita_iva,
            link_qr, last_sync
          ) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,NOW())
          ON CONFLICT(matricola) DO NOTHING
        `, [
          row.matricola, urlId, row.stato || '', row.ultima_vp || '', row.risultato_vp || '',
          row.partita_iva_vp || '', row.ultima_trasmissione || '', row.versione_fw || '',
          row.partita_iva || '', link
        ]);
      }
    }
    await client.query('COMMIT');
    console.log('Import iniziale completato.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function cleanText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
function pick(text, regex) { const m = text.match(regex); return m ? String(m[1] || '').trim() : ''; }
function parseAePage(html) {
  const text = cleanText(html);
  return {
    matricola: pick(text, /Matricola:\s*(.*?)\s+Stato:/i),
    stato: pick(text, /Stato:\s*(.*?)\s+Informazioni Dispositivo/i),
    data_vp: pick(text, /Ultima Verificazione Periodica\s+Data:\s*(\d{2}\/\d{2}\/\d{4})/i),
    risultato_vp: pick(text, /Ultima Verificazione Periodica\s+Data:\s*\d{2}\/\d{2}\/\d{4}\s+(.*?)\s+PIVA Laboratorio:/i),
    piva_laboratorio: pick(text, /PIVA Laboratorio:\s*([0-9]+)/i),
    cf_tecnico: pick(text, /CF Tecnico:\s*([A-Z0-9*]+)/i),
    ultima_trasmissione: pick(text, /Ultima Trasmissione da Dispositivo\s+Data:\s*(\d{2}\/\d{2}\/\d{4})/i),
    versione_software: pick(text, /Ultima versione software del dispositivo\s+Data Invio Manutenzione:\s*\d{2}\/\d{2}\/\d{4}\s+Versione:\s*([^\s]+)/i)
      || pick(text, /Ultima versione software del dispositivo.*?Versione:\s*([^\s]+)/i),
    partita_iva: pick(text, /Esercente\s+Partita IVA:\s*([0-9]+)/i),
    denominazione: pick(text, /Esercente\s+Partita IVA:\s*[0-9]+\s+Denominazione:\s*(.*?)\s+Elenco matricole/i),
    raw_preview: text.slice(0, 1000)
  };
}
function normalizeUrlInput(url) {
  const v = String(url || '').trim();
  if (!v) throw new Error('Link QR mancante');
  if (!/^https?:\/\//i.test(v)) throw new Error('Il QR non contiene un link valido');
  return v;
}
function hasUsefulData(d) { return Boolean(d && (d.matricola || d.stato || d.ultima_trasmissione || d.denominazione)); }

async function getCached(url, cacheHours) {
  if (!cacheHours || cacheHours <= 0) return null;
  const r = await pool.query(`SELECT payload FROM ae_cache WHERE url=$1 AND saved_at > NOW() - ($2 || ' hours')::interval`, [url, String(cacheHours)]);
  return r.rows[0]?.payload || null;
}
async function setCached(url, payload) {
  await pool.query(`INSERT INTO ae_cache(url,saved_at,payload) VALUES($1,NOW(),$2)
    ON CONFLICT(url) DO UPDATE SET saved_at=NOW(), payload=EXCLUDED.payload`, [url, JSON.stringify(payload)]);
}
async function fetchAndParse(url, opts = {}) {
  const safe = normalizeUrlInput(url);
  const cacheHours = Number(opts.cacheHours ?? DEFAULT_SYNC_CONFIG.cacheHours);
  const cached = await getCached(safe, cacheHours);
  if (cached) return { ...cached, fromCache: true };

  const response = await fetch(safe, { headers: { 'User-Agent': 'Mozilla/5.0 QR Manager Pro' } });
  const body = await response.text();
  const payload = { statusCode: response.status, data: parseAePage(body), rawPreview: cleanText(body).slice(0, 800), fromCache: false };
  if (response.ok && hasUsefulData(payload.data)) await setCached(safe, payload);
  return payload;
}

async function upsertImportedResult(url, data) {
  const matricola = String(data.matricola || '').trim();
  if (!matricola) throw new Error('Matricola non trovata nella pagina AE');

  const u = await pool.query(`INSERT INTO urls(url,last_checked) VALUES($1,NOW())
    ON CONFLICT(url) DO UPDATE SET last_checked=NOW() RETURNING id`, [url]);
  const urlId = u.rows[0].id;

  await pool.query(`
    INSERT INTO results(
      matricola,url_id,stato,ultima_vp,data_vp,risultato_vp,partita_iva_vp,cf_tecnico,
      ultima_trasmissione,versione_fw,partita_iva,denominazione,link_qr,last_sync,sync_error,sync_attempts,updated_at
    ) VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),' ',0,NOW())
    ON CONFLICT(matricola) DO UPDATE SET
      url_id=COALESCE(EXCLUDED.url_id,results.url_id),
      stato=COALESCE(NULLIF(EXCLUDED.stato,''),results.stato),
      ultima_vp=COALESCE(NULLIF(EXCLUDED.ultima_vp,''),results.ultima_vp),
      data_vp=COALESCE(NULLIF(EXCLUDED.data_vp,''),results.data_vp),
      risultato_vp=COALESCE(NULLIF(EXCLUDED.risultato_vp,''),results.risultato_vp),
      partita_iva_vp=COALESCE(NULLIF(EXCLUDED.partita_iva_vp,''),results.partita_iva_vp),
      cf_tecnico=COALESCE(NULLIF(EXCLUDED.cf_tecnico,''),results.cf_tecnico),
      ultima_trasmissione=COALESCE(NULLIF(EXCLUDED.ultima_trasmissione,''),results.ultima_trasmissione),
      versione_fw=COALESCE(NULLIF(EXCLUDED.versione_fw,''),results.versione_fw),
      partita_iva=COALESCE(NULLIF(EXCLUDED.partita_iva,''),results.partita_iva),
      denominazione=COALESCE(NULLIF(EXCLUDED.denominazione,''),results.denominazione),
      link_qr=EXCLUDED.link_qr,
      last_sync=NOW(),
      sync_error='',
      sync_attempts=0,
      updated_at=NOW()
  `, [
    matricola, urlId, data.stato || '', data.data_vp || '', data.risultato_vp || '',
    data.piva_laboratorio || '', data.cf_tecnico || '', data.ultima_trasmissione || '',
    data.versione_software || '', data.partita_iva || '', data.denominazione || '', url
  ]);

  return { matricola, url_id: urlId, last_sync: nowIso() };
}

async function buildQueue(mode = 'new') {
  const r = await pool.query(`
    SELECT r.matricola, r.ultima_trasmissione AS prima_ultima_trasmissione, r.url_id,
           COALESCE(r.link_qr, u.url) AS url, r.last_sync
    FROM results r
    LEFT JOIN urls u ON u.id = r.url_id
    WHERE COALESCE(r.link_qr, u.url) IS NOT NULL AND COALESCE(r.link_qr, u.url) <> ''
    ORDER BY CASE WHEN r.last_sync IS NULL THEN 0 ELSE 1 END, r.last_sync ASC NULLS FIRST, r.matricola ASC
  `);
  if (mode === 'resume' && syncState.currentIndex > 0 && syncState.currentIndex < r.rows.length) return r.rows.slice(syncState.currentIndex);
  syncState.currentIndex = 0;
  return r.rows;
}
async function syncOne(row, config) {
  syncState.currentMatricola = row.matricola;
  syncState.lastMessage = `Controllo ${syncState.checked + 1}/${syncState.total}: ${row.matricola}`;
  await saveSyncState();
  let lastErr = null;

  for (let a = 0; a <= Number(config.maxRetries || 0); a++) {
    try {
      const { statusCode, data, fromCache } = await fetchAndParse(row.url, { cacheHours: config.cacheHours });
      if (fromCache) syncState.cached++;

      if (!hasUsefulData(data)) {
        syncState.skipped++;
        await pool.query(`UPDATE results SET last_sync=NOW(), sync_error=$1, sync_attempts=COALESCE(sync_attempts,0)+1 WHERE matricola=$2`, [`Dati non trovati HTTP ${statusCode}`, row.matricola]);
        addSample({ matricola: row.matricola, esito: 'saltato', http: statusCode });
        return;
      }

      const saved = await upsertImportedResult(row.url, data);
      syncState.updated++;
      addSample({ matricola: saved.matricola, esito: 'aggiornato', ultima_trasmissione: data.ultima_trasmissione || '', cliente: data.denominazione || '', cache: fromCache });
      return;
    } catch (e) {
      lastErr = e;
      if (a < Number(config.maxRetries || 0)) await sleep(Math.max(1000, Number(config.delayMs || 1000)));
    }
  }

  syncState.errors++;
  await pool.query(`UPDATE results SET last_sync=NOW(), sync_error=$1, sync_attempts=COALESCE(sync_attempts,0)+1 WHERE matricola=$2`, [lastErr?.message || 'Errore', row.matricola]);
  addSample({ matricola: row.matricola, esito: 'errore', errore: lastErr?.message || 'Errore' });
}
async function processSyncQueue(mode = 'new', input = {}) {
  if (syncState.running) return syncState;
  const config = {
    ...DEFAULT_SYNC_CONFIG,
    ...input,
    batchSize: Math.max(1, Number(input.batchSize || DEFAULT_SYNC_CONFIG.batchSize)),
    delayMs: Math.max(300, Number(input.delayMs || DEFAULT_SYNC_CONFIG.delayMs)),
    cacheHours: Math.max(0, Number(input.cacheHours ?? DEFAULT_SYNC_CONFIG.cacheHours)),
    maxRetries: Math.max(0, Number(input.maxRetries ?? DEFAULT_SYNC_CONFIG.maxRetries))
  };

  const queue = await buildQueue(mode);
  syncState = {
    ...syncState,
    running: true,
    stopRequested: false,
    startedAt: nowIt(),
    finishedAt: null,
    total: mode === 'resume' ? Math.max(syncState.total || queue.length, queue.length + syncState.currentIndex) : queue.length,
    checked: mode === 'resume' ? (syncState.checked || 0) : 0,
    updated: mode === 'resume' ? (syncState.updated || 0) : 0,
    skipped: mode === 'resume' ? (syncState.skipped || 0) : 0,
    cached: mode === 'resume' ? (syncState.cached || 0) : 0,
    errors: mode === 'resume' ? (syncState.errors || 0) : 0,
    currentMatricola: '',
    lastMessage: 'Sync avviata',
    config,
    lastSamples: mode === 'resume' ? (syncState.lastSamples || []) : []
  };
  if (mode !== 'resume') syncState.currentIndex = 0;
  await saveSyncState();

  while (queue.length && !syncState.stopRequested) {
    const batch = queue.splice(0, config.batchSize);
    for (const row of batch) {
      if (syncState.stopRequested) break;
      await syncOne(row, config);
      syncState.checked++;
      syncState.currentIndex++;
      syncState.lastMessage = `Salvato progresso ${syncState.checked}/${syncState.total}`;
      await saveSyncState();
      await sleep(config.delayMs);
    }
    await saveSyncState();
    await sleep(Math.max(1000, config.delayMs));
  }

  syncState.running = false;
  syncState.finishedAt = nowIt();
  syncState.currentMatricola = '';
  syncState.lastMessage = syncState.stopRequested ? 'Sync interrotta. Puoi riprenderla.' : 'Sync completata.';
  await saveSyncState();
  return syncState;
}

async function getScheduleConfig() {
  const r = await pool.query(`SELECT * FROM schedule_config WHERE id=1`);
  const c = r.rows[0];
  return {
    enabled: c.enabled,
    frequency: c.frequency,
    time: c.time,
    dayOfWeek: c.day_of_week,
    dayOfMonth: c.day_of_month,
    batchSize: c.batch_size,
    delayMs: c.delay_ms,
    cacheHours: c.cache_hours,
    maxRetries: c.max_retries
  };
}
function shouldRunSchedule(c, now) {
  if (!c.enabled) return false;
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  if (`${hh}:${mm}` !== c.time) return false;
  if (c.frequency === 'daily') return true;
  if (c.frequency === 'weekly') return String(now.getDay()) === String(c.dayOfWeek);
  if (c.frequency === 'monthly') return String(now.getDate()) === String(c.dayOfMonth);
  return false;
}

app.get('/api/results', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const vpMonthRaw = String(req.query.vpMonth || '').trim();
  const vpMonth = vpMonthRaw ? vpMonthRaw.padStart(2, '0') : '';
  const vpYear = String(req.query.vpYear || '').trim();
  const page = Math.max(1, Number(req.query.page || 1));
  const perPage = Math.min(Math.max(1, Number(req.query.perPage || 100)), 500);
  const offset = (page - 1) * perPage;
  const like = `%${q}%`;

  const where = `
    WHERE (($1='' OR r.matricola ILIKE $2 OR r.stato ILIKE $2 OR r.partita_iva ILIKE $2 OR r.partita_iva_vp ILIKE $2 OR r.denominazione ILIKE $2 OR COALESCE(r.link_qr,u.url) ILIKE $2))
      AND ($3='' OR substring(COALESCE(r.data_vp,r.ultima_vp,'') from 4 for 2) = $3)
      AND ($4='' OR substring(COALESCE(r.data_vp,r.ultima_vp,'') from 7 for 4) = $4)
  `;
  const params = [q, like, vpMonth === '00' ? '' : vpMonth, vpYear];
  const totalR = await pool.query(`SELECT COUNT(*)::int AS total FROM results r LEFT JOIN urls u ON u.id=r.url_id ${where}`, params);
  const total = totalR.rows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const rowsR = await pool.query(`
    SELECT r.matricola,r.stato,COALESCE(r.data_vp,r.ultima_vp) AS data_vp,r.risultato_vp,
           r.partita_iva_vp AS piva_laboratorio,r.cf_tecnico,r.ultima_trasmissione,
           r.versione_fw AS versione_software,r.partita_iva,r.denominazione,
           COALESCE(r.link_qr,u.url) AS link_qr,
           TO_CHAR(r.last_sync AT TIME ZONE 'Europe/Rome','DD/MM/YYYY, HH24:MI:SS') AS last_sync,
           r.sync_error
    FROM results r LEFT JOIN urls u ON u.id=r.url_id ${where}
    ORDER BY r.matricola LIMIT $5 OFFSET $6
  `, [...params, perPage, offset]);
  res.json({ rows: rowsR.rows, page, perPage, total, totalPages });
});

app.post('/api/import-url', async (req, res) => {
  try {
    const url = normalizeUrlInput(req.body?.url);
    const { statusCode, data } = await fetchAndParse(url, { cacheHours: 0 });
    const saved = await upsertImportedResult(url, data);
    res.json({ ok: true, http: statusCode, saved, data, message: `QR importato e salvato: ${saved.matricola}` });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/sync/start', (req, res) => {
  if (syncState.running) return res.json({ ok: true, message: 'Sync già in corso', state: publicSyncState() });
  const mode = req.body?.resume ? 'resume' : 'new';
  processSyncQueue(mode, req.body || {}).catch(e => { syncState.running = false; syncState.errors++; syncState.lastMessage = 'Errore sync: ' + e.message; saveSyncState(); console.error(e); });
  res.json({ ok: true, message: mode === 'resume' ? 'Ripresa sync avviata' : 'Sync intelligente avviata', state: publicSyncState() });
});
app.post('/api/sync/stop', async (req, res) => { syncState.stopRequested = true; syncState.lastMessage = 'Richiesta interruzione ricevuta.'; await saveSyncState(); res.json({ ok: true, state: publicSyncState() }); });
app.get('/api/sync/status', (req, res) => res.json(publicSyncState()));
app.post('/api/cache/clear', async (req, res) => { await pool.query(`DELETE FROM ae_cache`); res.json({ ok: true, message: 'Cache svuotata' }); });
app.get('/api/schedule', async (req, res) => res.json(await getScheduleConfig()));
app.post('/api/schedule/save', async (req, res) => {
  const b = req.body || {};
  const c = {
    enabled: !!b.enabled,
    frequency: ['daily', 'weekly', 'monthly'].includes(b.frequency) ? b.frequency : 'daily',
    time: String(b.time || '01:00'),
    dayOfWeek: String(b.dayOfWeek || '1'),
    dayOfMonth: String(b.dayOfMonth || '1'),
    batchSize: Math.max(1, Number(b.batchSize || 25)),
    delayMs: Math.max(300, Number(b.delayMs || 1800)),
    cacheHours: Math.max(0, Number(b.cacheHours ?? 12)),
    maxRetries: Math.max(0, Number(b.maxRetries ?? 2))
  };
  await pool.query(`UPDATE schedule_config SET enabled=$1, frequency=$2, time=$3, day_of_week=$4, day_of_month=$5, batch_size=$6, delay_ms=$7, cache_hours=$8, max_retries=$9, updated_at=NOW() WHERE id=1`, [c.enabled, c.frequency, c.time, c.dayOfWeek, c.dayOfMonth, c.batchSize, c.delayMs, c.cacheHours, c.maxRetries]);
  res.json({ ok: true, config: c, message: 'Programmazione salvata' });
});
app.get('/download-db', async (req, res) => {
  const r = await pool.query(`SELECT * FROM results ORDER BY matricola`);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="qr-backup-postgres.json"');
  res.send(JSON.stringify(r.rows, null, 2));
});

let lastScheduleRunKey = '';
cron.schedule('* * * * *', async () => {
  try {
    const c = await getScheduleConfig();
    const n = new Date();
    if (!shouldRunSchedule(c, n) || syncState.running) return;
    const key = `${n.toISOString().slice(0, 10)}-${n.getHours()}-${n.getMinutes()}-${c.frequency}`;
    if (key === lastScheduleRunKey) return;
    lastScheduleRunKey = key;
    await processSyncQueue('new', c);
  } catch (e) { console.error('ERRORE SYNC PROGRAMMATA', e); }
});

async function start() {
  await initSchema();
  await seedFromSqliteIfEmpty();
  await loadSyncState();
  if (process.argv.includes('--seed-only')) { await pool.end(); return; }
  app.listen(PORT, () => console.log(`QR Manager Pro avviato: http://localhost:${PORT}`));
}
start().catch(e => { console.error(e); process.exit(1); });
