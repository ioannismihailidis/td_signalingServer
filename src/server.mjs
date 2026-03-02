import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 9980;
const PASSTHROUGH = process.env.PASSTHROUGH === 'true';
const SSL_CERT = process.env.SSL_CERT || null;
const SSL_KEY = process.env.SSL_KEY || null;

const API_VERSION = '1.0.1';
const SERVER_METADATA = Object.freeze({
  apiVersion: API_VERSION,
  compVersion: '1.0.0',
  compOrigin: 'td-signal-server',
  projectName: 'td-signal-server',
});

// ---------------------------------------------------------------------------
// Client tracking  –  Map<address, { ws, client }>
// ---------------------------------------------------------------------------

const clients = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildClient(address, domain) {
  return {
    id: crypto.randomUUID(),
    address,
    properties: {
      domain,
      timeJoined: Date.now(),
    },
  };
}

function createServerMessage(signalingType, content) {
  return JSON.stringify({
    metadata: SERVER_METADATA,
    signalingType,
    content,
  });
}

function sendTo(address, message) {
  const entry = clients.get(address);
  if (entry && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(message);
  }
}

function broadcastToDomain(domain, excludeAddress, message) {
  for (const [address, entry] of clients) {
    if (
      address !== excludeAddress &&
      entry.client.properties.domain === domain &&
      entry.ws.readyState === WebSocket.OPEN
    ) {
      entry.ws.send(message);
    }
  }
}

function getOtherClients(excludeAddress) {
  const others = [];
  for (const [address, entry] of clients) {
    if (address !== excludeAddress) {
      others.push(entry.client);
    }
  }
  return others;
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

function routeMessage(senderAddress, parsed) {
  // Always overwrite sender with the actual client address
  parsed.sender = senderAddress;

  const { target } = parsed;

  if (!target) {
    if (PASSTHROUGH) {
      // Broadcast to all other clients (excluding sender)
      const message = JSON.stringify(parsed);
      for (const [address, entry] of clients) {
        if (address !== senderAddress && entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(message);
        }
      }
    } else {
      console.warn(`[route] No target in ${parsed.signalingType || 'message'} from ${senderAddress}, passthrough disabled – dropping`);
    }
    return;
  }

  const targetEntry = clients.get(target);
  if (!targetEntry || targetEntry.ws.readyState !== WebSocket.OPEN) {
    console.warn(`[route] Target ${target} not found or not open`);
    return;
  }

  targetEntry.ws.send(JSON.stringify(parsed));
}

// ---------------------------------------------------------------------------
// Connection handlers
// ---------------------------------------------------------------------------

function handleMessage(senderAddress, rawData) {
  let parsed;
  try {
    parsed = JSON.parse(rawData.toString());
  } catch {
    console.error(`[parse-error] Invalid JSON from ${senderAddress}`);
    return;
  }

  // Validate metadata
  const metadata = parsed.metadata;
  if (!metadata) {
    console.error(`[message] Missing metadata from ${senderAddress} – dropping`);
    return;
  }

  // API version check
  if (metadata.apiVersion !== API_VERSION) {
    console.error(`[message] API version mismatch: client=${metadata.apiVersion} server=${API_VERSION} – dropping`);
    return;
  }

  const { signalingType } = parsed;
  if (!signalingType) {
    console.warn(`[message] Missing signalingType from ${senderAddress}`);
    return;
  }

  console.log(`[message] ${signalingType} from ${senderAddress} (${metadata.projectName}:${metadata.compOrigin})`);

  routeMessage(senderAddress, parsed);
}

function handleClose(address) {
  const entry = clients.get(address);
  if (!entry) return;

  clients.delete(address);
  console.log(`[disconnect] ${address} (${entry.client.id})`);

  // Broadcast ClientExit to same-domain clients only
  const message = createServerMessage('ClientExit', { client: entry.client });
  broadcastToDomain(entry.client.properties.domain, null, message);
}

function handleConnection(ws, req) {
  const ip = req.socket.remoteAddress;
  const port = req.socket.remotePort;
  const address = `${ip}:${port}`;

  // Domain from the URL pathname (e.g., ws://host:9980/room1 → "/room1")
  const domain = new URL(req.url, 'http://localhost').pathname;

  const client = buildClient(address, domain);
  console.log(`[connect] ${address} (${client.id}) domain=${domain}`);

  // 1. Tell the new client about itself
  ws.send(createServerMessage('ClientEntered', { self: client }));

  // 2. Send list of ALL other connected clients (no domain filter)
  ws.send(createServerMessage('Clients', { clients: getOtherClients(address) }));

  // 3. Broadcast ClientEnter to same-domain clients only
  broadcastToDomain(domain, address, createServerMessage('ClientEnter', { client }));

  // 4. NOW add client to the map (after sending messages)
  clients.set(address, { ws, client });

  // Wire per-socket events
  ws.on('message', (data) => handleMessage(address, data));
  ws.on('close', () => handleClose(address));
  ws.on('error', (err) => console.error(`[error] ${address}:`, err.message));
}

// ---------------------------------------------------------------------------
// HTTP handler — serves client.html at /
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML_PATH = path.join(__dirname, '..', 'test', 'client.html');

function handleHttpRequest(req, res) {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(CLIENT_HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('client.html not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

let server;

if (SSL_CERT && SSL_KEY) {
  server = https.createServer({
    cert: fs.readFileSync(SSL_CERT),
    key: fs.readFileSync(SSL_KEY),
  }, handleHttpRequest);
} else {
  server = http.createServer(handleHttpRequest);
}

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  const proto = SSL_CERT ? 'wss' : 'ws';
  console.log(`[server] TouchDesigner Signaling Server v${API_VERSION}`);
  console.log(`[server] Listening on ${proto}://0.0.0.0:${PORT}`);
  console.log(`[server] Client UI available at http${SSL_CERT ? 's' : ''}://0.0.0.0:${PORT}/`);
  console.log(`[server] Passthrough: ${PASSTHROUGH}`);
});

wss.on('connection', handleConnection);

wss.on('error', (err) => {
  console.error('[server-error]', err.message);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGINT', () => {
  console.log('\n[server] Shutting down...');
  wss.close(() => {
    console.log('[server] Closed.');
    process.exit(0);
  });
});
