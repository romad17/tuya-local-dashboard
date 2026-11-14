# Tuya Local Dashboard

A small Node.js app that runs on your PC, talks to the Tuya Cloud OpenAPI, and serves a web page where you can see all your devices live and control them.

```
Browser (localhost:3000)  <--SSE/REST-->  server.js  <--signed HTTPS-->  Tuya Cloud (openapi.tuyaeu.com)
```

The Access Secret stays in `.env` on your machine. The server listens on `127.0.0.1` only, so nothing else on your network can reach it.

## Setup (Windows)

1. Install Node.js LTS (22.13 or newer) from https://nodejs.org
2. In the Tuya developer platform open your project -> **Overview** and copy the **Access ID** and **Access Secret**.
3. Copy `.env.example` to `.env` and fill in `TUYA_ACCESS_ID` and `TUYA_ACCESS_SECRET`.
4. In a terminal in this folder:
   ```
   npm install
   npm start
   ```
   (or just double-click `start.bat`)
5. Open http://localhost:3000

## Credentials from environment variables instead of `.env`

`.env` is optional. If `TUYA_ACCESS_ID` and `TUYA_ACCESS_SECRET` are already set in your environment, they are used, and they take priority over anything in `.env`. The other settings (`TUYA_BASE_URL`, `PORT`, `POLL_SECONDS`, `DEVICE_IDS`) work the same way.

Windows PowerShell, saved for your user (applies to terminals opened afterwards):

```powershell
[Environment]::SetEnvironmentVariable('TUYA_ACCESS_ID', 'your_access_id', 'User')
[Environment]::SetEnvironmentVariable('TUYA_ACCESS_SECRET', 'your_access_secret', 'User')
```

Or for the current terminal only:

```powershell
$env:TUYA_ACCESS_ID = 'your_access_id'
$env:TUYA_ACCESS_SECRET = 'your_access_secret'
npm start
```

Linux / Synology / Docker:

```bash
TUYA_ACCESS_ID=... TUYA_ACCESS_SECRET=... npm start
# or: docker run -e TUYA_ACCESS_ID=... -e TUYA_ACCESS_SECRET=... ...
```

## History and charts

Every poll, the server saves readings (power, voltage, current, energy counter, temperature, humidity, battery) into a local SQLite file, `data/history.db`. Click **History** on a device card to see charts for 6 h, 24 h, 7 d or 30 d, plus a daily energy bar chart.

- **It only records while the server is running.** If your PC is off or the server is stopped, that time is a gap in the charts (shown as a break in the line, never bridged). Running it on an always-on machine, like the Synology, gives continuous history.
- **Daily energy (kWh)** is calculated by integrating the power readings over time. It doesn't depend on the device's own `add_ele` counter, whose meaning differs between devices. The `add_ele` counter is charted separately as-is.
- **Storage is small.** An unchanged value is saved only every 5 minutes, so expect a few MB per month for ~10 devices. `HISTORY_DAYS` (default 365) sets how long data is kept.
- **Finer detail:** lower `POLL_SECONDS` (minimum 10), at the cost of more API calls.
- **Backup / reset:** copy or delete the `data/` folder. It is git-ignored. On Docker, mount `data/` as a volume so history survives updates.
- Requires **Node 22.13 or newer** (uses the built-in `node:sqlite`). On older Node the dashboard still works, but without history.

## Tuya cloud statistics (same numbers as the app)

For devices with an energy counter (`add_ele`, e.g. the solar pump switches), the History window also shows **Daily energy, Tuya cloud statistics**: the data behind the Smart Life app's *Electricity Statistics* screen. Unlike the local recording, it also covers the time the dashboard wasn't running, going back to when the device joined the cloud.

It uses Tuya's Device Data Statistics API (`/v1.0/devices/{id}/statistics/days`). Whether it works depends on your Tuya project, so if it fails the History window shows why instead of a chart:

| Code | Meaning |
|---|---|
| `28841101` | The Statistics service isn't enabled for the project. Reports from other developers say it has to be requested through Tuya support rather than a normal subscribe button. |
| `2007` | Statistics aren't enabled for that data point on that product (a Tuya-side product setting). |
| `28841002` / `1106` | An API subscription or permission is missing (Service API tab). |

To compare with the app, open `http://localhost:3000/api/cloud-stats?dev=<device id>&days=30`. `rawSample` shows Tuya's untouched values for the last days, and `total` is the sum. If the numbers are off by a factor like 1000, tell me so the scaling can be adjusted.

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
