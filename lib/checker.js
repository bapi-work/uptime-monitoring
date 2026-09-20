const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { execFile } = require('child_process');
const { URL } = require('url');

function isExpectedStatus(code, expected) {
  if (!expected || expected === '2xx') return code >= 200 && code < 300;
  if (expected === '2xx-3xx') return code >= 200 && code < 400;
  const num = Number(expected);
  if (!Number.isNaN(num)) return code === num;
  return code >= 200 && code < 300;
}

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10;

function fetchOnce(url, monitor, started) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method: 'GET', timeout: (monitor.timeout || 10) * 1000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        if (body.length < 2_000_000) body += chunk;
      });
      res.on('end', () => {
        resolve({ code: res.statusCode || 0, headers: res.headers, body, ping: Date.now() - started, socket: res.socket });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchBody(monitor) {
  let url;
  try {
    url = new URL(monitor.url);
  } catch (e) {
    throw new Error('Invalid URL');
  }
  const started = Date.now();
  // Follow redirects by default (like a browser / Uptime Kuma), unless the
  // monitor explicitly expects a specific 3xx status code to be reported as-is.
  const followRedirects = monitor.expectedStatus !== '2xx-3xx' && Number.isNaN(Number(monitor.expectedStatus));

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchOnce(current, monitor, started);
    if (followRedirects && REDIRECT_STATUS_CODES.has(result.code) && result.headers && result.headers.location) {
      current = new URL(result.headers.location, current);
      continue;
    }
    return result;
  }
  throw new Error('Too many redirects');
}

function getCertInfo(monitor) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(monitor.url);
    } catch (e) {
      return resolve(null);
    }
    if (url.protocol !== 'https:') return resolve(null);
    const socket = tls.connect(
      { host: url.hostname, port: url.port || 443, servername: url.hostname, timeout: (monitor.timeout || 10) * 1000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return resolve(null);
        const validTo = new Date(cert.valid_to);
        const daysRemaining = Math.ceil((validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
        resolve({ validTo: validTo.toISOString(), daysRemaining });
      }
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', () => resolve(null));
  });
}

async function checkHttp(monitor) {
  try {
    const { code, ping } = await fetchBody(monitor);
    const ok = isExpectedStatus(code, monitor.expectedStatus);
    return { status: ok ? 'up' : 'down', ping, message: ok ? `HTTP ${code}` : `HTTP ${code} (unexpected)` };
  } catch (err) {
    return { status: 'down', ping: null, message: err.message };
  }
}

async function checkKeyword(monitor) {
  try {
    const { code, body, ping } = await fetchBody(monitor);
    if (!isExpectedStatus(code, monitor.expectedStatus)) {
      return { status: 'down', ping, message: `HTTP ${code} (unexpected)` };
    }
    const found = body.includes(monitor.keyword || '');
    const wantFound = monitor.keywordType !== 'not_contains';
    const ok = found === wantFound;
    return {
      status: ok ? 'up' : 'down',
      ping,
      message: ok
        ? `Keyword check passed`
        : `Keyword "${monitor.keyword}" ${wantFound ? 'not found' : 'found'} in response`,
    };
  } catch (err) {
    return { status: 'down', ping: null, message: err.message };
  }
}

function getByPath(obj, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

async function checkJsonQuery(monitor) {
  try {
    const { code, body, ping } = await fetchBody(monitor);
    if (!isExpectedStatus(code, monitor.expectedStatus)) {
      return { status: 'down', ping, message: `HTTP ${code} (unexpected)` };
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return { status: 'down', ping, message: 'Response is not valid JSON' };
    }
    const value = getByPath(json, monitor.jsonPath);
    const ok = String(value) === String(monitor.jsonExpected);
    return {
      status: ok ? 'up' : 'down',
      ping,
      message: ok ? 'JSON query matched' : `JSON path "${monitor.jsonPath}" = ${JSON.stringify(value)}, expected ${monitor.jsonExpected}`,
    };
  } catch (err) {
    return { status: 'down', ping: null, message: err.message };
  }
}

async function checkDns(monitor) {
  const resolver = new dns.promises.Resolver();
  const started = Date.now();
  try {
    const type = (monitor.dnsRecordType || 'A').toUpperCase();
    const methodMap = { A: 'resolve4', AAAA: 'resolve6', CNAME: 'resolveCname', MX: 'resolveMx', TXT: 'resolveTxt', NS: 'resolveNs', SRV: 'resolveSrv', PTR: 'resolvePtr' };
    const method = methodMap[type] || 'resolve4';
    const records = await resolver[method](monitor.host || monitor.url);
    const ping = Date.now() - started;
    const flat = JSON.stringify(records);
    if (monitor.dnsExpected) {
      const ok = flat.includes(monitor.dnsExpected);
      return {
        status: ok ? 'up' : 'down',
        ping,
        message: ok ? `Resolved, contains expected value` : `Resolved but did not contain "${monitor.dnsExpected}"`,
      };
    }
    return { status: 'up', ping, message: `Resolved ${records.length} record(s)` };
  } catch (err) {
    return { status: 'down', ping: null, message: err.message };
  }
}

// Only allow characters valid in a hostname or IP (v4/v6) — this is both an
// input sanity check and, combined with execFile (no shell), the guard against
// command injection via a monitor's host field.
const SAFE_HOST_RE = /^[a-zA-Z0-9.:_-]+$/;

function checkPing(monitor) {
  return new Promise((resolve) => {
    const target = monitor.host || monitor.url;
    if (!target || !SAFE_HOST_RE.test(target)) {
      return resolve({ status: 'down', ping: null, message: 'Invalid host' });
    }
    const isWin = process.platform === 'win32';
    const timeoutSec = monitor.timeout || 10;
    const args = isWin ? ['-n', '1', '-w', String(timeoutSec * 1000), target] : ['-c', '1', '-W', String(timeoutSec), target];
    const started = Date.now();
    execFile('ping', args, { timeout: timeoutSec * 1000 + 2000 }, (error, stdout) => {
      const ping = Date.now() - started;
      if (error) {
        return resolve({ status: 'down', ping: null, message: 'Host unreachable' });
      }
      const timeMatch = stdout.match(/time[=<]([\d.]+)/i);
      resolve({
        status: 'up',
        ping: timeMatch ? Math.round(parseFloat(timeMatch[1])) : ping,
        message: 'Ping successful',
      });
    });
  });
}

function checkTcp(monitor) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const timeoutMs = (monitor.timeout || 10) * 1000;
    let done = false;

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      done = true;
      const ping = Date.now() - started;
      socket.destroy();
      resolve({ status: 'up', ping, message: 'Connected' });
    });
    socket.once('timeout', () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ status: 'down', ping: null, message: 'Timeout' });
    });
    socket.once('error', (err) => {
      if (done) return;
      done = true;
      resolve({ status: 'down', ping: null, message: err.message });
    });
    socket.connect(monitor.port, monitor.host);
  });
}

function checkWebsocket(monitor) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(monitor.url);
    } catch (e) {
      return resolve({ status: 'down', ping: null, message: 'Invalid URL' });
    }
    const isSecure = url.protocol === 'wss:' || url.protocol === 'https:';
    const port = url.port || (isSecure ? 443 : 80);
    const started = Date.now();
    const lib = isSecure ? tls : net;
    const key = Buffer.from(Math.random().toString(36)).toString('base64');
    const req =
      `GET ${url.pathname || '/'} HTTP/1.1\r\n` +
      `Host: ${url.hostname}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`;
    const timeoutMs = (monitor.timeout || 10) * 1000;
    const opts = isSecure ? { host: url.hostname, port, servername: url.hostname, timeout: timeoutMs } : { host: url.hostname, port, timeout: timeoutMs };
    const socket = lib.connect(opts, () => {
      socket.write(req);
    });
    let data = '';
    let done = false;
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        done = true;
        const ping = Date.now() - started;
        const upgraded = /101/.test(data.split('\r\n')[0]);
        socket.destroy();
        resolve({ status: upgraded ? 'up' : 'down', ping, message: upgraded ? 'Handshake OK' : 'Handshake failed' });
      }
    });
    socket.on('timeout', () => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ status: 'down', ping: null, message: 'Timeout' });
    });
    socket.on('error', (err) => {
      if (done) return;
      done = true;
      resolve({ status: 'down', ping: null, message: err.message });
    });
  });
}

async function runCheck(monitor) {
  switch (monitor.type) {
    case 'tcp':
      return checkTcp(monitor);
    case 'keyword':
      return checkKeyword(monitor);
    case 'json_query':
      return checkJsonQuery(monitor);
    case 'dns':
      return checkDns(monitor);
    case 'ping':
      return checkPing(monitor);
    case 'websocket':
      return checkWebsocket(monitor);
    default:
      return checkHttp(monitor);
  }
}

module.exports = { runCheck, getCertInfo };
