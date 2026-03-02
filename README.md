# TD Signaling Server

A Node.js WebSocket signaling server for TouchDesigner WebRTC connections. Implements the [TouchDesigner Signaling API v1.0.1](https://github.com/TouchDesigner/SignalingAPI).

## Project Structure

```
td_signalingServer/
  src/
    server.mjs          # Signaling server
  test/
    client.html         # Web client for testing WebRTC streams
  docker/
    Dockerfile          # Container image (Node 22 Alpine)
    docker-compose.yml  # Compose configuration
  package.json
```

## Quick Start

```bash
npm install
npm start
```

The server starts on `ws://localhost:9980` by default.

## Configuration

All settings are via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `9980` | Server listen port |
| `PASSTHROUGH` | `false` | Enable passthrough mode (see below) |
| `SSL_CERT` | — | Path to SSL certificate file (enables `wss://`) |
| `SSL_KEY` | — | Path to SSL private key file (enables `wss://`) |

Examples:

```bash
# Custom port
PORT=8080 npm start

# With SSL
SSL_CERT=./cert.pem SSL_KEY=./key.pem npm start

# With passthrough enabled
PASSTHROUGH=true npm start
```

### Passthrough Mode

Normally, all routed messages (Offer, Answer, Ice) require a `target` field specifying which client should receive the message. If a message arrives without a `target`, the server drops it.

When `PASSTHROUGH=true`, untargeted messages are instead **broadcast to all other connected clients** (excluding the sender). This is useful for scenarios where a client needs to send a message to everyone without knowing their individual addresses.

## Docker

```bash
cd docker
docker compose up --build
```

Edit `docker/docker-compose.yml` to configure port, passthrough, or SSL. To enable SSL, uncomment the SSL environment variables and volume mount, then place your cert files in `docker/certs/`.

## Signaling API

The server implements all message types from the TouchDesigner Signaling API v1.0.1:

### Server-originated messages

| Message | Direction | Description |
|---------|-----------|-------------|
| `ClientEntered` | Server -> Client | Acknowledges a new client with its assigned ID and address |
| `Clients` | Server -> Client | Lists all other connected clients |
| `ClientEnter` | Server -> Same-domain clients | Notifies that a new client joined |
| `ClientExit` | Server -> Same-domain clients | Notifies that a client disconnected |

### Client-routed messages

| Message | Direction | Description |
|---------|-----------|-------------|
| `Offer` | Client -> Client (via server) | WebRTC SDP offer |
| `Answer` | Client -> Client (via server) | WebRTC SDP answer |
| `Ice` | Client -> Client (via server) | ICE candidate exchange |

All routed messages require a `target` field (client address in `IP:port` format). The server always sets the `sender` field to the actual client address.

### Domains

The WebSocket URL path acts as a domain for client isolation. Clients connecting to `ws://host:9980/room1` and `ws://host:9980/room2` are in separate domains — `ClientEnter` and `ClientExit` messages are only broadcast within the same domain.

### Message format

Every message follows this structure:

```json
{
  "metadata": {
    "apiVersion": "1.0.1",
    "compVersion": "1.0.0",
    "compOrigin": "td-signal-server",
    "projectName": "td-signal-server"
  },
  "signalingType": "ClientEntered",
  "content": { ... }
}
```

Routed messages additionally include `sender` and `target` fields.

## Test Client

Open `test/client.html` in a browser to test the signaling server with TouchDesigner:

1. Start the server with `npm start`
2. Open `test/client.html` in a browser
3. Enter the server URL and click **Connect**
4. Start a WebRTC COMP in TouchDesigner pointing at the same server
5. The video stream appears automatically

The test client supports video and audio tracks, fullscreen mode, and logs all signaling activity.

## Requirements

- Node.js >= 18
- TouchDesigner (for WebRTC streaming)
