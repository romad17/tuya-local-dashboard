# Tuya Local Dashboard

A small Node.js app that runs on your PC, talks to the Tuya Cloud OpenAPI, and serves a web page where you can see all your devices live and control them.

```
Browser (localhost:3000)  <--SSE/REST-->  server.js  <--signed HTTPS-->  Tuya Cloud (openapi.tuyaeu.com)
```

The Access Secret stays in `.env` on your machine. The server listens on `127.0.0.1` only, so nothing else on your network can reach it.

## Setup (Windows)

1. Install Node.js LTS (18 or newer) from https://nodejs.org
2. In the Tuya developer platform open your project -> **Overview** and copy the **Access ID** and **Access Secret**.
3. Copy `.env.example` to `.env` and fill in `TUYA_ACCESS_ID` and `TUYA_ACCESS_SECRET`.
4. In a terminal in this folder:
   ```
   npm install
   npm start
   ```
   (or just double-click `start.bat`)
5. Open http://localhost:3000

## Troubleshooting

| Error | Likely cause |
|---|---|
| `1004 sign invalid` | Wrong Access ID/Secret, or copied with extra spaces |
| `1106 permission deny` / `28841002 No permissions` | The project is missing an API subscription (Service API tab: IoT Core, Authorization Token Management, Smart Home Basic Service / Industry Basic Service), or the trial expired |
| `1100 param is empty or illegal` on the device list | Use `DEVICE_IDS` in `.env` instead, listing your device IDs |
| Empty device list | The app account isn't linked, or the data center doesn't match your project (Central Europe -> `https://openapi.tuyaeu.com`) |
| A device shows read-only values | Its data point has no writable function in the product definition |

## How it works

- `server.js` fetches all devices with `GET /v1.0/iot-01/associated-users/devices` (one call returns status for every device), then repeats every `POLL_SECONDS` seconds.
- `GET /v1.0/devices/{id}/specifications` is fetched once per device to learn which data points are writable and how values are scaled (e.g. power in 0.1 W steps).
- Commands go through `POST /v1.0/devices/{id}/commands` with `{ "commands": [{ "code": "switch_1", "value": true }] }`, and the device status is re-read about a second later.
- Updates are pushed to the page with Server-Sent Events.

## API quota

Polling uses roughly `86400 / POLL_SECONDS` calls per day. Check your plan's quota in the platform, and raise `POLL_SECONDS` if needed.

## Moving to the Synology NAS later

Nothing here is Windows-specific. Run the same folder on the NAS with Node (or Docker). The server currently listens on `127.0.0.1` only, so to reach it from other devices you'd change the listen address in `server.js`, and you should add authentication first because the page can switch your devices.
