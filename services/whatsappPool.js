const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const { WhatsAppService } = require('./whatsappService');
const { HttpError } = require('./httpError');

/**
 * Multi-app pool for the standalone WhatsApp service.
 *
 * Each app is identified by `name` and gets its own WhatsAppService instance
 * (its own paired number, its own session dir, its own optional webhook URL).
 *
 * Persistent state lives in `<authDir>/apps.json` so registrations survive
 * restarts. Sessions live in `<authDir>/session-<clientId>/` and are managed
 * by whatsapp-web.js LocalAuth.
 */
class WhatsAppPool {
  constructor({ authDir, defaultAppToken, maxInstances, idleEvictMs } = {}) {
    this.authDir = authDir || path.join(process.cwd(), '.wwebjs_auth');
    this.defaultAppToken = defaultAppToken || null;
    // Soft ceiling on concurrently-initialised Chromium instances. Each app is
    // a full browser; on a shared host with many clinics this prevents unbounded
    // memory growth. Evicting only targets COLD, non-connected instances, so
    // paired/sending sessions are never torn down by the cap.
    this.maxInstances = Number(maxInstances) || 50;
    // How long an instance may sit non-connected and idle before the reaper
    // tears it down (session preserved on disk; re-inits on next request).
    this.idleEvictMs = Number(idleEvictMs) || 30 * 60 * 1000;
    this.registryPath = path.join(this.authDir, 'apps.json');
    this.apps = {}; // name → { name, label, token, webhookUrl, clientId, createdAt }
    this.instances = {}; // name → WhatsAppService

    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    this._load();
  }

  // ── Registry persistence ────────────────────────────────────────────────

  _load() {
    if (!fs.existsSync(this.registryPath)) {
      this.apps = {};
      return;
    }
    try {
      const raw = fs.readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      this.apps = parsed.apps || {};
    } catch (err) {
      logger.error(`[pool] failed to load apps registry: ${err.message}`);
      this.apps = {};
    }
  }

  _persist() {
    const tmp = this.registryPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ apps: this.apps }, null, 2));
    fs.renameSync(tmp, this.registryPath);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────

  /**
   * Ensure the legacy `nice-agenda` app exists, mapped to the existing
   * paired session at `session-nice-agenda-whatsapp`. This is what makes
   * the migration to the multi-app model invisible to the live system.
   */
  ensureDefaultApp() {
    const name = 'nice-agenda';
    if (this.apps[name]) return this.apps[name];

    const entry = {
      name,
      label: 'Nice Agenda',
      // Use the env-supplied token if provided so the backend's WHATSAPP_APP_TOKEN
      // matches without operator coordination. Otherwise generate a fresh one.
      token: this.defaultAppToken || this._generateToken(),
      webhookUrl: process.env.WHATSAPP_DEFAULT_WEBHOOK_URL || null,
      clientId: 'nice-agenda-whatsapp', // existing paired session
      createdAt: new Date().toISOString(),
    };
    this.apps[name] = entry;
    this._persist();
    logger.info(`[pool] auto-registered default app "${name}" (clientId=${entry.clientId})`);
    return entry;
  }

  // ── App management ─────────────────────────────────────────────────────

  list() {
    return Object.values(this.apps).map(a => ({
      name: a.name,
      label: a.label,
      webhookUrl: a.webhookUrl,
      clientId: a.clientId,
      createdAt: a.createdAt,
      status: this.instances[a.name] ? this.instances[a.name].getStatus() : null,
    }));
  }

  get(name) {
    return this.apps[name] || null;
  }

  register({ name, label, webhookUrl }) {
    if (!name || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) {
      throw new HttpError(400, 'App name must be lowercase alphanumeric with dashes (1-64 chars)');
    }
    if (this.apps[name]) {
      throw new HttpError(409, `App "${name}" already registered`);
    }
    const entry = {
      name,
      label: label || name,
      token: this._generateToken(),
      webhookUrl: webhookUrl || null,
      clientId: name, // new apps use their name as the LocalAuth clientId
      createdAt: new Date().toISOString(),
    };
    this.apps[name] = entry;
    this._persist();
    logger.info(`[pool] registered new app "${name}"`);
    return entry;
  }

  update(name, { label, webhookUrl }) {
    const a = this.apps[name];
    if (!a) throw new HttpError(404, `App "${name}" not found`);
    if (label !== undefined) a.label = label;
    if (webhookUrl !== undefined) a.webhookUrl = webhookUrl || null;
    this._persist();
    return a;
  }

  async unregister(name) {
    const a = this.apps[name];
    if (!a) throw new HttpError(404, `App "${name}" not found`);
    if (this.instances[name]) {
      try { await this.instances[name].disconnect(); } catch (_) {}
      delete this.instances[name];
    }
    // Wipe the session dir so the next registration with the same name
    // starts fresh and the old QR isn't accidentally reused.
    const sessionDir = path.join(this.authDir, `session-${a.clientId}`);
    if (fs.existsSync(sessionDir)) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
    }
    delete this.apps[name];
    this._persist();
    logger.info(`[pool] unregistered app "${name}"`);
  }

  rotateToken(name) {
    const a = this.apps[name];
    if (!a) throw new HttpError(404, `App "${name}" not found`);
    a.token = this._generateToken();
    this._persist();
    return a.token;
  }

  verifyToken(name, token) {
    const a = this.apps[name];
    if (!a) return false;
    if (!a.token || !token) return false;
    // constant-time compare
    const expected = Buffer.from(a.token);
    const got = Buffer.from(String(token));
    if (expected.length !== got.length) return false;
    return crypto.timingSafeEqual(expected, got);
  }

  // ── Client lifecycle ───────────────────────────────────────────────────

  /**
   * Get-or-create the WhatsAppService instance for an app. The instance is
   * NOT auto-initialised — call `.initialize()` or `.connect()` explicitly,
   * matching the existing single-app semantics.
   */
  instance(name) {
    if (!this.apps[name]) return null;
    if (!this.instances[name]) {
      // At the cap, try to free a cold slot before spinning up another browser.
      if (Object.keys(this.instances).length >= this.maxInstances) {
        const evicted = this._evictColdest();
        if (!evicted) {
          logger.warn(`[pool] over instance cap (${this.maxInstances}) and none idle — creating "${name}" anyway; consider raising WHATSAPP_MAX_INSTANCES or scaling out`);
        }
      }
      const a = this.apps[name];
      this.instances[name] = new WhatsAppService({
        appName: a.name,
        clientId: a.clientId,
        authDir: this.authDir,
        onEvent: (eventType, payload) => this._dispatchWebhook(a, eventType, payload),
      });
    }
    return this.instances[name];
  }

  /** True if the instance is safe to tear down without losing live work. */
  _isCold(inst) {
    return inst && !inst.isConnected && !inst.isInitializing;
  }

  /**
   * Tear down (non-destructively) the single coldest idle instance to free a
   * slot. Returns the evicted name, or null if every instance is busy.
   */
  _evictColdest() {
    let target = null;
    let oldest = Infinity;
    for (const [name, inst] of Object.entries(this.instances)) {
      if (!this._isCold(inst)) continue;
      const last = inst.lastActivity || 0;
      if (last < oldest) { oldest = last; target = name; }
    }
    if (!target) return null;
    const inst = this.instances[target];
    // Fire-and-forget the browser teardown; drop the reference immediately so
    // the slot frees up. Session on disk is preserved by shutdown().
    Promise.resolve().then(() => inst.shutdown()).catch(() => {});
    delete this.instances[target];
    logger.info(`[pool] evicted cold instance "${target}" to free a slot`);
    return target;
  }

  /**
   * Reap instances that have been non-connected and idle past idleEvictMs.
   * Preserves the on-disk session — only the live Chromium is released.
   * Call on an interval from the service entrypoint.
   */
  async reap(now = Date.now()) {
    const evicted = [];
    for (const [name, inst] of Object.entries(this.instances)) {
      if (!this._isCold(inst)) continue;
      if (now - (inst.lastActivity || 0) < this.idleEvictMs) continue;
      try { await inst.shutdown(); } catch (_) {}
      delete this.instances[name];
      evicted.push(name);
    }
    if (evicted.length) logger.info(`[pool] reaped idle instances: ${evicted.join(', ')}`);
    return evicted;
  }

  /**
   * Non-destructive teardown of EVERY live instance — for process shutdown.
   * Closes browsers cleanly but preserves all sessions on disk so pairings
   * survive the restart. NEVER wipes session dirs (that's disconnect()).
   */
  async shutdownAll() {
    await Promise.all(
      Object.values(this.instances).map(inst => inst.shutdown().catch(() => {}))
    );
  }

  /**
   * Eagerly initialise an app's client (used at startup for the default app
   * so the existing session reconnects without waiting for the first request).
   */
  async warmup(name) {
    const inst = this.instance(name);
    if (!inst) return null;
    return inst.initialize();
  }

  // ── Webhook delivery ───────────────────────────────────────────────────

  async _dispatchWebhook(app, eventType, payload) {
    if (!app.webhookUrl) return;
    const body = JSON.stringify({ event: eventType, ...payload });
    const signature = crypto
      .createHmac('sha256', app.token || '')
      .update(body)
      .digest('hex');

    const send = async (attempt) => {
      try {
        await axios.post(app.webhookUrl, body, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'X-WhatsApp-Event': eventType,
            'X-WhatsApp-App': app.name,
            'X-WhatsApp-Signature': `sha256=${signature}`,
          },
        });
        logger.info(`[pool] webhook delivered: ${app.name} ${eventType}`);
      } catch (err) {
        const status = err.response?.status || 'no-response';
        logger.warn(`[pool] webhook ${app.name} ${eventType} failed (attempt ${attempt}, ${status}): ${err.message}`);
        if (attempt < 3) {
          // Exponential backoff: 2s, 8s
          setTimeout(() => send(attempt + 1), 2000 * Math.pow(4, attempt - 1));
        }
      }
    };
    // Fire-and-forget — never block the WhatsApp event loop on a slow webhook.
    send(1);
  }

  _generateToken() {
    return crypto.randomBytes(24).toString('hex'); // 48 chars
  }
}

module.exports = WhatsAppPool;
