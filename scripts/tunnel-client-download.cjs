const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = Object.freeze([250, 750, 1500]);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutError(url, requestTimeoutMs) {
  const error = new Error(`Download request timed out after ${requestTimeoutMs} ms for ${url}`);
  error.code = "ETIMEDOUT";
  return error;
}

async function fetchBytesWithRetry(url, {
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  maxAttempts = MAX_ATTEMPTS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS) {
    throw new Error(`requestTimeoutMs must be an integer from 1 to ${MAX_REQUEST_TIMEOUT_MS}.`);
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(createTimeoutError(url, requestTimeoutMs));
    }, requestTimeoutMs);

    try {
      const response = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
      if (response.ok) return Buffer.from(await response.arrayBuffer());

      const status = Number(response.status);
      const error = new Error(`Download failed (${status}) for ${url}`);
      error.httpStatus = status;
      if (!isRetryableStatus(status)) throw error;
      lastError = error;
    } catch (error) {
      const attemptError = timedOut ? createTimeoutError(url, requestTimeoutMs) : error;
      if (Number.isInteger(attemptError?.httpStatus) && !isRetryableStatus(attemptError.httpStatus)) throw attemptError;
      lastError = attemptError;
    } finally {
      clearTimeout(timer);
    }

    if (attempt === maxAttempts) break;
    await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
  }

  const status = Number.isInteger(lastError?.httpStatus) ? ` (${lastError.httpStatus})` : "";
  throw new Error(`Download failed after ${maxAttempts} attempts${status} for ${url}: ${lastError?.message || "network error"}`);
}

module.exports = { fetchBytesWithRetry };
