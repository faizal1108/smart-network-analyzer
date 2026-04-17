# Smart Network Analyzer

A full-stack DevOps demo project that provides real-time network monitoring, detailed interface visibility, public IP/ISP insights, and observability with Prometheus + Grafana.

## Stack

- Backend: FastAPI + `psutil`
- Frontend: HTML + Tailwind CSS + Vanilla JavaScript
- Monitoring: Prometheus + Grafana
- Containers: Docker + Docker Compose

## Project Structure

```text
smart-network-analyzer/
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── index.html
│   ├── script.js
│   ├── nginx.conf
│   └── Dockerfile
├── grafana/
│   └── provisioning/
│       ├── datasources/datasource.yml
│       └── dashboards/
│           ├── dashboard.yml
│           └── json/smart-network-dashboard.json
├── prometheus.yml
└── docker-compose.yml
```

## Features

### 1) Network Traffic Monitor
- Real-time upload/download speed
- Total bytes sent/received
- Full network interface table (type, name, IP, status)
- Per-interface upload/download speed (calculated every second)
- Auto-refresh every 1 second
- Start/Stop monitoring button
- Manual refresh button

### 2) IP Information
- Public IP via `GET /ip` using external IP API
- ISP/Network provider
- City and country
- Organization details

### 3) Professional Light UI
- Clean light theme with Tailwind CSS
- Responsive cards and table layout
- Active interfaces highlighted for demo clarity

## Backend API Endpoints

- `GET /ping`
- `GET /network-stats`
- `GET /network-interfaces`
- `GET /ip`
- `GET /metrics` (Prometheus scrape endpoint)

## Run with Docker Compose (Recommended)

From the `smart-network-analyzer` folder:

```bash
docker compose up --build
```

### Access URLs

- App (Frontend): [http://localhost:8080](http://localhost:8080)
- Backend API: [http://localhost:8000](http://localhost:8000)
- Backend Swagger: [http://localhost:8000/docs](http://localhost:8000/docs)
- Prometheus: [http://localhost:9090](http://localhost:9090)
- Grafana: [http://localhost:3000](http://localhost:3000)
  - Username: `admin`
  - Password: `admin`

To stop:

```bash
docker compose down
```

## Optional Local Run (Without Docker)

### Backend

```bash
cd backend
python -m venv .venv
# PowerShell
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

Serve `frontend` with any static web server. Example:

```bash
cd frontend
python -m http.server 5500
```

If running without nginx proxy, update `API_BASE` in `script.js` from `/api` to `http://localhost:8000`.

## Notes

- The frontend proxies `/api/*` to backend through nginx (inside Docker), so no browser CORS setup is needed.
- Prometheus scrapes backend metrics every 5 seconds.
- Grafana comes pre-provisioned with Prometheus datasource and a sample dashboard.

### Public IP / ISP panel

- The backend tries several HTTPS providers (`ipapi.co`, `ipinfo.io`, `ipify` + detail) with a real browser-like `User-Agent`.
- If the container cannot reach those services, the UI automatically falls back to a **browser-side** lookup (your real client public IP as seen by the provider).
- Docker internal addresses (for example `172.x.x.x`) are never shown as “public IP”.
# smart-network-analyzer
