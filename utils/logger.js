const logLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'warn' : 'debug');
const enableConsole = process.env.ENABLE_CONSOLE_LOGGING !== 'false';

class Logger {
  constructor() {
    this.logLevel = logLevel;
    this.enableConsole = enableConsole;
  }

  _shouldLog(level) {
    const levels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3
    };

    return levels[level] <= levels[this.logLevel];
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...meta
    };

    if (this.enableConsole) {
      const colorMap = {
        error: '\x1b[31m', // Red
        warn: '\x1b[33m',  // Yellow
        info: '\x1b[36m',  // Cyan
        debug: '\x1b[37m'  // White
      };

      const reset = '\x1b[0m';
      const color = colorMap[level] || '';

      console.log(`${color}[${timestamp}] ${level.toUpperCase()}: ${message}${reset}`,
        Object.keys(meta).length > 0 ? meta : '');
    }

    return logEntry;
  }

  error(message, meta = {}) {
    if (this._shouldLog('error')) {
      return this._formatMessage('error', message, meta);
    }
  }

  warn(message, meta = {}) {
    if (this._shouldLog('warn')) {
      return this._formatMessage('warn', message, meta);
    }
  }

  info(message, meta = {}) {
    if (this._shouldLog('info')) {
      return this._formatMessage('info', message, meta);
    }
  }

  debug(message, meta = {}) {
    if (this._shouldLog('debug')) {
      return this._formatMessage('debug', message, meta);
    }
  }

  logRequest(req, res, responseTime) {
    const meta = {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress
    };

    if (res.statusCode >= 400) {
      this.warn(`${req.method} ${req.url} - ${res.statusCode}`, meta);
    } else {
      this.info(`${req.method} ${req.url} - ${res.statusCode}`, meta);
    }
  }
}

module.exports = new Logger();
