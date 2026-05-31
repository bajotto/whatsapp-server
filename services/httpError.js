/**
 * Error carrying an HTTP status code. Thrown by pool/service logic so the
 * route wrapper can map it to the right status instead of a blanket 500.
 * Plain Errors (no .status) still fall back to 500 — those are real failures.
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

module.exports = { HttpError };
