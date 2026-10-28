// The safe shape for an unexpected server error returned to the client.
// Exposes the error code (a coarse identifier such as a Node errno) but never the message, which can carry absolute paths or subprocess output.
//
// Local patch (Ignis Control, 2026-10-27; patches/0003-diagnostics.patch): the full error is kept for the server's
// own log. The request logger runs each request in `requestContext`; sanitizeError records the error there, and the
// logger prints its code and message beside the failed request, so the log says why (EPERM, ENOENT, …) and for
// which file, while the client still gets only the code.

const { AsyncLocalStorage } = require("async_hooks");

const requestContext = new AsyncLocalStorage();

function sanitizeError(e) {
  const store = requestContext.getStore();

  if (store && e != null) {
    store.error = e;
  }

  const code = e == null ? undefined : e.code;
  return { error: code || "internal", code };
}

module.exports = { sanitizeError, requestContext };
