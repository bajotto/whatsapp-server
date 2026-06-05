const { Client, LocalAuth } = require('whatsapp-web.js');
const logger = require('../utils/logger');
const { HttpError } = require('./httpError');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const INITIALIZE_TIMEOUT_MS = 90000;

/**
 * One WhatsApp client = one paired phone number = one named "app instance".
 *
 * The class is parameterised so the multi-app pool can spawn many of these
 * inside a single Node process. Legacy code paths that import the default
 * singleton get an instance with appName="nice-agenda" and the original
 * clientId, so the existing paired session continues to load unchanged.
 */
class WhatsAppService {
  /**
   * @param {object} opts
   * @param {string} opts.appName        Human-readable app instance name (used in logs/events)
   * @param {string} [opts.clientId]     LocalAuth clientId (defaults to appName)
   * @param {string} [opts.authDir]      Root .wwebjs_auth directory; default = process.cwd()/.wwebjs_auth
   * @param {function} [opts.onEvent]    Callback `(eventType, payload) => void` for webhook fan-out
   */
  constructor(opts = {}) {
    this.appName = opts.appName || 'default';
    this.clientId = opts.clientId || this.appName;
    this.authDir = opts.authDir || path.join(process.cwd(), '.wwebjs_auth');
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

    this.client = null;
    this.isConnected = false;
    this.isInitializing = false;
    // Last time this instance did anything useful (status/connect/send). Used by
    // the pool's idle reaper to evict cold, non-connected Chromium instances so
    // a shared host with many apps doesn't accumulate unbounded browsers.
    this.lastActivity = Date.now();
    this.isAuthenticating = false; // true between 'authenticated' and 'ready'
    this.qrCode = null;
    this.qrGeneratedAt = null; // ms epoch — used by the UI to show QR age
    this.phoneNumber = null;
    this.lastError = null;
    this.sessionData = null;
    this.messageTemplates = [];
    this.clients = [];

    // Auto-reconnect state
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    // Whether the last disconnect was explicitly requested (via disconnect()).
    // When true, auto-reconnect is suppressed.
    this._explicitDisconnect = false;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  _emit(type, payload) {
    try {
      this.onEvent(type, { app: this.appName, ...payload });
    } catch (err) {
      logger.warn(`[${this.appName}] webhook emit failed: ${err.message}`);
    }
  }

  async initialize() {
    if (this.client) {
      return { success: true, message: 'WhatsApp service already initialized', reused: true };
    }
    if (this.isInitializing) {
      return { success: true, message: 'WhatsApp service initialization in progress', pending: true };
    }
    // An explicit call to initialize() clears the explicit-disconnect flag so
    // that auto-reconnect resumes if the session drops again later.
    this._explicitDisconnect = false;
    this.isInitializing = true;
    this.lastError = null;

    try {
      if (!fs.existsSync(this.authDir)) {
        fs.mkdirSync(this.authDir, { recursive: true });
      }

      // Clear stale Chromium singleton lockfiles for THIS client's session dir.
      const sessionDir = path.join(this.authDir, `session-${this.clientId}`);
      for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lockPath = path.join(sessionDir, lockFile);
        if (fs.existsSync(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
            logger.info(`[${this.appName}] 🧹 Removed stale Chromium lock: ${lockFile}`);
          } catch (e) {
            logger.warn(`[${this.appName}] could not remove ${lockFile}: ${e.message}`);
          }
        }
      }

      // Sweep stale Chromium temp sockets
      try {
        const tmpDir = '/tmp';
        for (const f of fs.readdirSync(tmpDir).filter(x => x.startsWith('.org.chromium.Chromium'))) {
          try { fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true }); } catch (_) {}
        }
      } catch (_) { /* ignore */ }

      this.client = new Client({
        authStrategy: new LocalAuth({
          clientId: this.clientId,
          dataPath: this.authDir,
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            // --single-process and --no-zygote intentionally omitted (break QR handshake)
          ],
        },
      });

      this.client.on('qr', async (qr) => {
        logger.info(`[${this.appName}] 📱 QR Code generated`);
        qrcode.generate(qr, { small: true });
        try {
          this.qrCode = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
        } catch (err) {
          logger.error(`[${this.appName}] failed to convert QR: ${err.message}`);
          this.qrCode = qr;
        }
        this.qrGeneratedAt = Date.now();
        this._emit('qr', { qrCode: this.qrCode, qrGeneratedAt: this.qrGeneratedAt });
      });

      this.client.on('loading_screen', (percent, msg) => {
        logger.info(`[${this.appName}] ⏳ loading: ${percent}% - ${msg}`);
      });

      this.client.on('change_state', (state) => {
        logger.info(`[${this.appName}] 🔄 state: ${state}`);
      });

      this.client.on('ready', () => {
        this.isConnected = true;
        this.isAuthenticating = false;
        this.qrCode = null;
        this.qrGeneratedAt = null;
        this.phoneNumber = this.client.info?.wid?.user || null;
        logger.info(`[${this.appName}] ✅ ready as +${this.phoneNumber}`);
        this._emit('ready', { phoneNumber: this.phoneNumber });
      });

      this.client.on('authenticated', () => {
        logger.info(`[${this.appName}] 🔐 authenticated, waiting for ready...`);
        // QR was scanned — clear it so the UI stops showing the stale code
        // and shows a "finalizing" state instead.
        this.isAuthenticating = true;
        this.qrCode = null;
        this.qrGeneratedAt = null;
        this._emit('authenticated', {});
      });

      this.client.on('auth_failure', (msg) => {
        logger.error(`[${this.appName}] ❌ auth_failure: ${msg}`);
        this.isConnected = false;
        this.isAuthenticating = false;
        this.qrCode = null;
        this._emit('auth_failure', { message: String(msg) });
      });

      this.client.on('disconnected', (reason) => {
        logger.info(`[${this.appName}] 📱 disconnected: ${reason}`);
        this.isConnected = false;
        this.isAuthenticating = false;
        this.qrCode = null;
        this.qrGeneratedAt = null;
        this.phoneNumber = null;
        // Null the client so initialize() knows it needs to create a new one.
        this.client = null;
        this._emit('disconnected', { reason: String(reason) });

        // Auto-reconnect unless this was an intentional disconnect.
        if (!this._explicitDisconnect) {
          this._scheduleReconnect();
        }
      });

      this.client.on('message', async (msg) => {
        try {
          // WhatsApp's number-privacy ("LID") addressing delivers inbound
          // messages with `from` as "<lid>@lid" instead of "<phone>@c.us".
          // Downstream webhook consumers match patients by phone number, so we
          // resolve the LID back to the phone JID here. The resolution is
          // best-effort: on any failure we keep the raw id (no regression), and
          // we always expose the original via `lid`/`rawFrom`.
          let from = msg.from;
          let senderLid = null;
          if (typeof from === 'string' && from.endsWith('@lid')) {
            senderLid = from;
            try {
              const [mapping] = await this.client.getContactLidAndPhone([from]);
              if (mapping && mapping.pn) from = mapping.pn;
              else logger.warn(`[${this.appName}] LID->phone unresolved for ${from}`);
            } catch (e) {
              logger.warn(`[${this.appName}] LID->phone resolve failed for ${from}: ${e.message}`);
            }
          }

          this._emit('message', {
            id: msg.id?._serialized,
            from,                 // resolved to <phone>@c.us when the sender uses LID
            lid: senderLid,       // original LID id, when present (else null)
            rawFrom: msg.from,    // always the unmodified WhatsApp id
            to: msg.to,
            body: msg.body,
            type: msg.type,
            timestamp: msg.timestamp,
            isFromMe: msg.fromMe === true,
            hasMedia: !!msg.hasMedia,
          });
        } catch (err) {
          logger.warn(`[${this.appName}] message webhook payload failed: ${err.message}`);
        }
      });

      // Fire-and-forget initialise (resolves only after pairing on fresh sessions)
      const initPromise = this.client.initialize().catch(err => {
        logger.error(`[${this.appName}] client.initialize() failed: ${err.message}`);
        this.lastError = err.message;
        this.isConnected = false;
      });

      const firstSignal = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No QR or ready event within ${INITIALIZE_TIMEOUT_MS}ms`)),
          INITIALIZE_TIMEOUT_MS
        );
        const done = (kind) => { clearTimeout(timer); resolve(kind); };
        this.client.once('qr', () => done('qr'));
        this.client.once('ready', () => done('ready'));
        this.client.once('auth_failure', (msg) => { clearTimeout(timer); reject(new Error(`auth_failure: ${msg}`)); });
      });

      await firstSignal;
      this.isInitializing = false;
      initPromise.then(() => {}, () => {});

      return { success: true, message: 'WhatsApp service initialized' };
    } catch (error) {
      logger.error(`[${this.appName}] ❌ initialize failed: ${error.message}`);
      this.lastError = error.message;
      this.isInitializing = false;
      if (this.client) {
        try { await this.client.destroy(); } catch (_) {}
        this.client = null;
      }
      // Schedule auto-reconnect on initialization failure (e.g. timeout waiting
      // for QR or Chromium crash), unless the disconnect was intentional.
      if (!this._explicitDisconnect) {
        this._scheduleReconnect();
      }
      return { success: false, error: error.message };
    }
  }

  async connect() {
    try {
      this.touch();
      if (!this.client && !this.isInitializing) {
        const r = await this.initialize();
        if (!r.success) return { success: false, error: r.error || 'Initialization failed' };
      }
      if (this.isConnected) {
        return { success: true, isConnected: true, phoneNumber: this.phoneNumber, qrCode: null };
      }
      if (this.qrCode) {
        return { success: true, isConnected: false, qrCode: this.qrCode };
      }
      for (let i = 0; i < 16; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (this.qrCode || this.isConnected) break;
      }
      return {
        success: true,
        isConnected: this.isConnected,
        qrCode: this.qrCode,
        phoneNumber: this.phoneNumber,
      };
    } catch (error) {
      logger.error(`[${this.appName}] connect failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async requestPairingCode(phoneNumber) {
    try {
      if (this.isConnected) return { success: false, error: 'Already connected' };
      if (!this.client) {
        const init = await this.initialize();
        if (!init.success) return { success: false, error: init.error || 'Initialization failed' };
      }
      if (!this.qrCode) {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (this.qrCode || this.isConnected) break;
        }
        if (!this.qrCode) {
          return { success: false, error: 'WhatsApp client not ready yet — try again in a few seconds.' };
        }
      }
      const digits = String(phoneNumber || '').replace(/\D/g, '');
      if (digits.length < 8) {
        return { success: false, error: 'Invalid phone number — include country code (e.g. 5547999990188)' };
      }
      if (this.client.pupPage) {
        await this.client.pupPage.evaluate(() => {
          if (typeof window.onCodeReceivedEvent !== 'function') {
            window.onCodeReceivedEvent = (code) => code;
          }
        });
      }
      const code = await this.client.requestPairingCode(digits, false);
      return { success: true, pairingCode: code, phoneNumber: digits };
    } catch (err) {
      logger.error(`[${this.appName}] requestPairingCode failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ── Auto-reconnect ────────────────────────────────────────────────────────

  _scheduleReconnect() {
    if (this._reconnectTimer) return; // already scheduled
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s, cap at 120s.
    const delay = Math.min(5000 * Math.pow(2, this._reconnectAttempt), 120000);
    this._reconnectAttempt += 1;
    logger.info(`[${this.appName}] 🔄 scheduling reconnect attempt ${this._reconnectAttempt} in ${delay / 1000}s`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._explicitDisconnect) return;
      logger.info(`[${this.appName}] 🔄 auto-reconnect attempt ${this._reconnectAttempt}`);
      try {
        const result = await this.initialize();
        if (result.success) {
          logger.info(`[${this.appName}] ✅ auto-reconnect succeeded`);
          this._reconnectAttempt = 0;
        } else {
          logger.warn(`[${this.appName}] ⚠️  auto-reconnect failed: ${result.error}`);
          this._scheduleReconnect();
        }
      } catch (err) {
        logger.error(`[${this.appName}] ❌ auto-reconnect error: ${err.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  // ─────────────────────────────────────────────────────────────────────────

  async disconnect() {
    try {
      this._explicitDisconnect = true;
      this._reconnectAttempt = 0;
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this.client) {
        await this.client.destroy();
        this.client = null;
      }
      // Wipe persisted LocalAuth session so the next connect() starts fresh with a new QR.
      const sessionDir = path.join(this.authDir, `session-${this.clientId}`);
      if (fs.existsSync(sessionDir)) {
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
          logger.info(`[${this.appName}] 🧹 Cleared session dir on explicit disconnect`);
        } catch (e) {
          logger.warn(`[${this.appName}] could not clear session dir: ${e.message}`);
        }
      }
      this.isConnected = false;
      this.qrCode = null;
      this.qrGeneratedAt = null;
      this.phoneNumber = null;
      return { success: true, message: 'WhatsApp disconnected successfully' };
    } catch (error) {
      logger.error(`[${this.appName}] disconnect failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Non-destructive teardown: close the Chromium browser but PRESERVE the
   * persisted LocalAuth session on disk so the pairing survives. Use this for
   * process shutdown (SIGTERM/SIGINT) and idle eviction — NOT for an explicit
   * user "disconnect / forget me", which must wipe the session via disconnect().
   *
   * Deliberately does NOT set _explicitDisconnect, so a re-initialize() later
   * reconnects from the saved session without a fresh QR scan.
   */
  async shutdown() {
    try {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this.client) {
        await this.client.destroy();
        this.client = null;
      }
      this.isConnected = false;
      this.isInitializing = false;
      this.qrCode = null;
      return { success: true, message: 'WhatsApp client torn down (session preserved)' };
    } catch (error) {
      logger.error(`[${this.appName}] shutdown failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ── Brazilian phone normalisation ─────────────────────────────────────────

  normalizeBrazilianPhoneNumber(phoneNumber) {
    if (!phoneNumber) throw new HttpError(400, 'Phone number is required');
    const original = phoneNumber.replace(/\D/g, '');

    // Non-Brazilian numbers arrive already normalised (e.g. "351912345678").
    // They won't start with "55", so skip BR-specific logic and use as-is when
    // the length is plausibly international (12–15 digits with country code).
    if (!original.startsWith('55') && original.length >= 10 && original.length <= 15) {
      return original;
    }

    let digits = original;
    if (digits.startsWith('55')) digits = digits.substring(2);

    if (digits.length === 11) return '55' + digits;
    if (digits.length === 10) {
      const ddd = digits.substring(0, 2);
      const number = digits.substring(2, 10);
      return '55' + ddd + '9' + number;
    }
    if (digits.length === 13) {
      if (original.length === 13 && original.startsWith('55')) return original;
    }
    if (digits.length >= 8 && digits.length <= 15) {
      if (digits.length === 10 || digits.length === 9) {
        return '55' + digits.substring(0, 2) + '9' + digits.substring(2);
      }
      // Fallback: number arrived with enough digits — use as-is
      if (digits.length >= 10) return '55' + digits;
    }
    throw new HttpError(400, `Invalid phone format: ${phoneNumber} (${digits.length} digits). Expected: 55[DDD][9][8digits]`);
  }

  getAlternativeBrazilianNumber(phoneNumber) {
    const digits = phoneNumber.replace(/\D/g, '');
    if (!digits.startsWith('55')) return null;
    const local = digits.substring(2);
    if (local.length === 11 && local[2] === '9') {
      return '55' + local.substring(0, 2) + local.substring(3);
    } else if (local.length === 10) {
      return '55' + local.substring(0, 2) + '9' + local.substring(2);
    }
    return null;
  }

  async resolveWhatsAppId(phoneNumber) {
    const candidates = [phoneNumber];
    const alt = this.getAlternativeBrazilianNumber(phoneNumber);
    if (alt) candidates.push(alt);
    for (const candidate of candidates) {
      try {
        const numberId = await this.client.getNumberId(candidate);
        if (numberId) {
          logger.info(`[${this.appName}] 📞 resolved +${candidate} → ${numberId._serialized}`);
          return numberId;
        }
      } catch (err) {
        logger.warn(`[${this.appName}] getNumberId failed for +${candidate}: ${err.message}`);
      }
    }
    return null;
  }

  async sendMessage(to, message) {
    try {
      this.touch();
      if (!this.isConnected || !this.client) {
        return { success: false, error: 'WhatsApp not connected' };
      }
      const phoneNumber = this.normalizeBrazilianPhoneNumber(to);
      const numberId = await this.resolveWhatsAppId(phoneNumber);
      if (!numberId) {
        return {
          success: false,
          error: `No LID for user: +${phoneNumber} is not registered on WhatsApp (tried with and without the mobile "9" prefix)`,
        };
      }
      const result = await this.client.sendMessage(numberId._serialized, message);
      logger.info(`[${this.appName}] ✅ sent to ${numberId._serialized}`);
      return {
        success: true,
        messageId: result.id._serialized,
        message: 'Message sent successfully',
      };
    } catch (error) {
      logger.error(`[${this.appName}] sendMessage failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  getStatus() {
    this.touch();
    return {
      app: this.appName,
      isConnected: this.isConnected,
      isInitializing: this.isInitializing,
      isAuthenticating: this.isAuthenticating,
      hasClient: !!this.client,
      qrCode: this.qrCode,
      qrGeneratedAt: this.qrGeneratedAt,
      phoneNumber: this.phoneNumber,
      lastError: this.lastError,
      sessionData: this.sessionData,
    };
  }

  processTemplate(template, variables = {}) {
    let processed = template.content;
    Object.keys(variables).forEach(key => {
      const placeholder = `{${key}}`;
      const value = variables[key] || '';
      processed = processed.replace(new RegExp(placeholder, 'g'), value);
    });
    return processed;
  }
}

module.exports = { WhatsAppService };
