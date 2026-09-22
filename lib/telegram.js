'use strict';

/**
 * Telegram Bot API client.
 *
 * Uses https.request (NOT built-in fetch) so standard Node http/socks proxy
 * agents apply directly — built-in fetch is Undici-based and silently ignores
 * the `agent` option. Supports direct, HTTP(S) and SOCKS proxies.
 */

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { safeProxyLabel, resolveProxy } = require('./proxy');

const DEFAULT_TIMEOUT_MS = 90_000;

function makeAgent(proxyUrl) {
  const u = new URL(proxyUrl);
  if (u.protocol.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Create the client.
 * opts: { token, explicitProxy, execImpl (for Windows registry probe), log }
 */
function createTelegramClient({ token, explicitProxy = '', execImpl, log = console.log }) {
  const API = `https://api.telegram.org/bot${token}`;

  let currentAgent = null;
  let currentSource = null;
  let currentUrl = null;
  let needsReprobe = true;

  function refresh(reason) {
    const { url, source } = resolveProxy({ explicit: explicitProxy, execImpl });
    const agent = url ? makeAgent(url) : null;
    const changed = url !== currentUrl || source !== currentSource;
    currentUrl = url;
    currentSource = source;
    currentAgent = agent;
    needsReprobe = false;
    if (changed) {
      log(`proxy -> ${safeProxyLabel(url)} [${source || 'direct'}]${reason ? ` (${reason})` : ''}`);
    }
    return { url, source };
  }

  function state() {
    if (needsReprobe) refresh('re-probe');
    return { agent: currentAgent, source: currentSource, label: safeProxyLabel(currentUrl) };
  }

  function markFailure() {
    needsReprobe = true;
  }

  /**
   * POST JSON to the Bot API. Resolves with data.result.
   * Retries network failures with backoff, re-resolving the proxy each time.
   */
  function request(method, params, { attempt = 1, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const maxAttempts = 6;
    return new Promise((resolveOuter, rejectOuter) => {
      const { agent } = state();
      const payload = Buffer.from(JSON.stringify(params || {}), 'utf8');
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          path: `/bot${token}/${method}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
          },
          agent: agent || undefined,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size <= 8 * 1024 * 1024) chunks.push(c); // hard cap; Telegram replies are small
          });
          res.on('end', () => {
            let data = {};
            try {
              data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              /* handled below via ok check */
            }
            if (data && data.ok) {
              resolveOuter(data.result);
              return;
            }
            const retryAfter = data && data.parameters && data.parameters.retry_after;
            const desc = (data && data.description) || `HTTP ${res.statusCode}`;
            if (res.statusCode === 429 && retryAfter) {
              log(`rate limited on ${method}, waiting ${retryAfter}s`);
              setTimeout(() => {
                request(method, params, { attempt, timeoutMs })
                  .then(resolveOuter)
                  .catch(rejectOuter);
              }, (retryAfter + 1) * 1000);
              return;
            }
            const err = new Error(`Telegram ${method} failed: ${desc}`);
            err.statusCode = res.statusCode;
            rejectOuter(err);
          });
          res.on('error', rejectOuter);
        }
      );

      req.on('timeout', () => req.destroy(new Error(`request to ${method} timed out after ${timeoutMs}ms`)));

      req.on('error', (err) => {
        if (attempt < maxAttempts) {
          markFailure();
          const wait = Math.min(30, attempt * 5) * 1000;
          const { label } = state();
          log(`network error on ${method} (attempt ${attempt}/${maxAttempts}), retrying in ${wait / 1000}s via ${label}`);
          setTimeout(() => {
            request(method, params, { attempt: attempt + 1, timeoutMs })
              .then(resolveOuter)
              .catch(rejectOuter);
          }, wait);
          return;
        }
        rejectOuter(err);
      });

      req.write(payload);
      req.end();
    });
  }

  return { request, refresh, state, markFailure };
}

module.exports = { createTelegramClient, makeAgent, DEFAULT_TIMEOUT_MS };
