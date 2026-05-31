require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const WhatsAppPool = require('./services/whatsappPool');

// Clear stale Chromium singleton lockfiles for ALL session dirs before
// instantiating any client. Crashed containers leave SingletonLock symlinks
// that prevent Chromium from reusing the profile.
(() => {
  const authRoot = path.join(__dirname, '.wwebjs_auth');
  if (!fs.existsSync(authRoot)) return;
  for (const sessionDir of fs.readdirSync(authRoot)) {
    const dir = path.join(authRoot, sessionDir);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch { continue; }
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { fs.unlinkSync(path.join(dir, name)); } catch {}
    }
  }
})();

const app = express();
const PORT = process.env.PORT || 2061;
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_APP = process.env.DEFAULT_APP_NAME || 'nice-agenda';
const DEFAULT_APP_TOKEN = process.env.DEFAULT_APP_TOKEN || null;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Pool ─────────────────────────────────────────────────────────────────

const pool = new WhatsAppPool({
  authDir: path.join(__dirname, '.wwebjs_auth'),
  defaultAppToken: DEFAULT_APP_TOKEN,
  maxInstances: process.env.WHATSAPP_MAX_INSTANCES,
  idleEvictMs: process.env.WHATSAPP_IDLE_EVICT_MS,
});
pool.ensureDefaultApp();

// Eagerly warm up the default app so the existing paired session
// reconnects on boot — preserves the legacy "auto-initialise on startup"
// behaviour from the single-app version.
const initializeDefault = async () => {
  try {
    console.log(`🚀 Warming up default app "${DEFAULT_APP}"...`);
    const r = await pool.warmup(DEFAULT_APP);
    if (r && r.success) console.log(`✅ Default app "${DEFAULT_APP}" initialised`);
    else console.error(`❌ Default app warmup: ${r && r.error}`);
  } catch (err) {
    console.error('❌ Default app warmup error:', err.message);
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────

const requireApp = (req, res, next) => {
  const name = req.params.app;
  const entry = pool.get(name);
  if (!entry) return res.status(404).json({ success: false, error: `App "${name}" not registered` });
  req.appEntry = entry;
  next();
};

const requireAppToken = (req, res, next) => {
  const token = req.get('X-WhatsApp-App-Token') || req.query.token;
  if (!pool.verifyToken(req.appEntry.name, token)) {
    return res.status(401).json({ success: false, error: 'Invalid or missing X-WhatsApp-App-Token' });
  }
  next();
};

// Admin-only: registering/listing apps requires a master token. If
// ADMIN_TOKEN is unset, admin endpoints are disabled (defensive default).
const ADMIN_TOKEN = process.env.WHATSAPP_ADMIN_TOKEN || null;
const requireAdmin = (req, res, next) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ success: false, error: 'Admin API disabled (WHATSAPP_ADMIN_TOKEN not set)' });
  }
  if (req.get('X-WhatsApp-Admin-Token') !== ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Invalid admin token' });
  }
  next();
};

const wrap = (fn) => (req, res) => fn(req, res).catch(err => {
  console.error(`Error in ${req.method} ${req.path}:`, err);
  res.status(500).json({ success: false, error: err.message });
});

// ── /v2/apps — registry management (admin) ───────────────────────────────

app.get('/v2/apps', requireAdmin, (req, res) => {
  res.json({ success: true, apps: pool.list() });
});

app.post('/v2/apps', requireAdmin, wrap(async (req, res) => {
  const { name, label, webhookUrl } = req.body || {};
  const entry = pool.register({ name, label, webhookUrl });
  res.json({ success: true, app: entry }); // includes token — only shown once at register time
}));

app.patch('/v2/apps/:app', requireAdmin, requireApp, wrap(async (req, res) => {
  const { label, webhookUrl } = req.body || {};
  const updated = pool.update(req.appEntry.name, { label, webhookUrl });
  res.json({ success: true, app: updated });
}));

app.post('/v2/apps/:app/rotate-token', requireAdmin, requireApp, wrap(async (req, res) => {
  const token = pool.rotateToken(req.appEntry.name);
  res.json({ success: true, token });
}));

app.delete('/v2/apps/:app', requireAdmin, requireApp, wrap(async (req, res) => {
  await pool.unregister(req.appEntry.name);
  res.json({ success: true });
}));

// ── /v2/wa/:app/* — per-app WhatsApp operations (token auth) ─────────────

app.get('/v2/wa/:app/status', requireApp, requireAppToken, (req, res) => {
  const inst = pool.instance(req.appEntry.name);
  res.json({ success: true, data: inst.getStatus() });
});

app.post('/v2/wa/:app/connect', requireApp, requireAppToken, wrap(async (req, res) => {
  const inst = pool.instance(req.appEntry.name);
  if (!inst.client && !inst.isInitializing) await inst.initialize();
  const result = await inst.connect();
  res.json(result);
}));

app.post('/v2/wa/:app/pairing-code', requireApp, requireAppToken, wrap(async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ success: false, error: 'phoneNumber is required' });
  const inst = pool.instance(req.appEntry.name);
  if (!inst.client && !inst.isInitializing) await inst.initialize();
  res.json(await inst.requestPairingCode(phoneNumber));
}));

app.post('/v2/wa/:app/disconnect', requireApp, requireAppToken, wrap(async (req, res) => {
  const inst = pool.instance(req.appEntry.name);
  res.json(await inst.disconnect());
}));

app.post('/v2/wa/:app/send', requireApp, requireAppToken, wrap(async (req, res) => {
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ success: false, error: 'Missing required fields: to, message' });
  const inst = pool.instance(req.appEntry.name);
  if (!inst.isConnected) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  res.json(await inst.sendMessage(to, message));
}));

// ── /api/whatsapp/* — legacy alias for the default app (NO token check) ──
// Kept for backwards compatibility while nice-agenda backends roll over to
// the v2 endpoints. These hit the same default-app instance.

const defaultInstance = () => pool.instance(DEFAULT_APP);

app.get('/api/whatsapp/status', (req, res) => {
  const inst = defaultInstance();
  res.json({
    success: true,
    data: {
      initialized: !!(inst && inst.client),
      ...(inst ? inst.getStatus() : {}),
    },
  });
});

app.post('/api/whatsapp/connect', wrap(async (req, res) => {
  const inst = defaultInstance();
  if (!inst.client && !inst.isInitializing) await inst.initialize();
  res.json(await inst.connect());
}));

app.post('/api/whatsapp/pairing-code', wrap(async (req, res) => {
  const { phoneNumber } = req.body || {};
  if (!phoneNumber) return res.status(400).json({ success: false, error: 'phoneNumber is required' });
  const inst = defaultInstance();
  if (!inst.client && !inst.isInitializing) await inst.initialize();
  res.json(await inst.requestPairingCode(phoneNumber));
}));

app.post('/api/whatsapp/disconnect', wrap(async (req, res) => {
  res.json(await defaultInstance().disconnect());
}));

app.post('/api/whatsapp/send', wrap(async (req, res) => {
  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ success: false, error: 'Missing required fields: to, message' });
  const inst = defaultInstance();
  if (!inst.isConnected) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
  res.json(await inst.sendMessage(to, message));
}));

app.get('/api/whatsapp/health', (req, res) => {
  res.json({ status: 'OK', service: 'WhatsApp', timestamp: new Date().toISOString() });
});

// ── Boot ─────────────────────────────────────────────────────────────────

// ── Idle reaper ────────────────────────────────────────────────────────────
// Periodically release cold, non-connected Chromium instances so a shared host
// with many clinics doesn't accumulate unbounded browsers. Sessions on disk are
// preserved — only the live browser is torn down.
const REAP_INTERVAL_MS = Number(process.env.WHATSAPP_REAP_INTERVAL_MS) || 5 * 60 * 1000;
const reaper = setInterval(() => {
  pool.reap().catch(err => console.error('reaper error:', err.message));
}, REAP_INTERVAL_MS);
if (reaper.unref) reaper.unref();

app.listen(PORT, HOST, () => {
  console.log(`🌐 WhatsApp service listening on ${HOST}:${PORT}`);
  console.log(`📦 Apps registered: ${Object.keys(pool.apps).join(', ') || '(none)'}`);
  console.log(`🔑 Admin API: ${ADMIN_TOKEN ? 'enabled' : 'disabled (set WHATSAPP_ADMIN_TOKEN to enable)'}`);
  initializeDefault();
});

// Graceful, NON-DESTRUCTIVE shutdown. Closes browsers but preserves every
// paired session on disk so a restart/redeploy never forces a re-scan. We must
// NOT call disconnect() here — that wipes session dirs (it's the explicit
// "forget me" path). Handle both SIGTERM (docker stop / orchestrators) and
// SIGINT (Ctrl+C); a flag prevents a double run if both fire.
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${signal} received — closing WhatsApp browsers (sessions preserved)...`);
  clearInterval(reaper);
  try { await pool.shutdownAll(); } catch (_) {}
  process.exit(0);
};
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
