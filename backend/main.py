import socket
import time
from datetime import datetime, timezone
from typing import AsyncGenerator
from typing import Any

import httpx
import psutil
from fastapi import FastAPI, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from prometheus_client import Gauge
from prometheus_fastapi_instrumentator import Instrumentator


app = FastAPI(title="Smart Network Analyzer API")

# Prometheus custom gauges for host network counters.
net_sent_gauge = Gauge("smart_network_bytes_sent", "Total bytes sent by host")
net_recv_gauge = Gauge("smart_network_bytes_received", "Total bytes received by host")


def _net_sent() -> float:
    return float(psutil.net_io_counters().bytes_sent)


def _net_recv() -> float:
    return float(psutil.net_io_counters().bytes_recv)


net_sent_gauge.set_function(_net_sent)
net_recv_gauge.set_function(_net_recv)

Instrumentator().instrument(app).expose(app, include_in_schema=False, endpoint="/metrics")


@app.get("/ping")
async def ping() -> dict:
    return {"message": "pong", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/download-test")
async def download_test(size_mb: int = 20) -> StreamingResponse:
    chunk_size = 1024 * 1024
    total_bytes = max(1, min(size_mb, 200)) * chunk_size

    async def stream_bytes() -> AsyncGenerator[bytes, None]:
        sent = 0
        chunk = b"0" * chunk_size
        while sent < total_bytes:
            remaining = min(chunk_size, total_bytes - sent)
            sent += remaining
            yield chunk[:remaining]

    return StreamingResponse(stream_bytes(), media_type="application/octet-stream")


@app.post("/upload-test")
async def upload_test(file: UploadFile) -> JSONResponse:
    start = time.perf_counter()
    total_bytes = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total_bytes += len(chunk)
    elapsed = max(time.perf_counter() - start, 1e-6)
    upload_mbps = (total_bytes * 8) / elapsed / 1_000_000
    return JSONResponse(
        {
            "filename": file.filename,
            "size_bytes": total_bytes,
            "elapsed_seconds": round(elapsed, 4),
            "upload_mbps": round(upload_mbps, 2),
        }
    )


def _get_primary_ipv4(addresses: list[psutil._common.snicaddr]) -> str:  # type: ignore[attr-defined]
    for addr in addresses:
        if addr.family.name == "AF_INET":
            return addr.address
    return "-"


def _get_interface_type(name: str) -> str:
    lowered = name.lower()
    if "wi-fi" in lowered or "wifi" in lowered or "wlan" in lowered:
        return "wifi"
    if "eth" in lowered or "ethernet" in lowered or "en" in lowered:
        return "ethernet"
    return "other"


def _list_interfaces() -> list[dict[str, Any]]:
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()
    io_counters = psutil.net_io_counters(pernic=True)

    results: list[dict[str, Any]] = []
    for name in sorted(addrs.keys()):
        addr_list = addrs.get(name, [])
        iface_stats = stats.get(name)
        iface_io = io_counters.get(name)
        is_up = bool(iface_stats.isup) if iface_stats else False
        status = "UP" if is_up else "DOWN"
        results.append(
            {
                "name": name,
                "ip": _get_primary_ipv4(addr_list),
                "status": status,
                "is_up": is_up,
                "type": _get_interface_type(name),
                "bytes_sent": iface_io.bytes_sent if iface_io else 0,
                "bytes_received": iface_io.bytes_recv if iface_io else 0,
            }
        )
    return results


@app.get("/network-interfaces")
async def network_interfaces() -> JSONResponse:
    interfaces = _list_interfaces()
    active = [interface for interface in interfaces if interface["is_up"]]
    return JSONResponse({"timestamp": datetime.now(timezone.utc).isoformat(), "interfaces": interfaces, "active_count": len(active)})


@app.get("/network-stats")
async def network_stats() -> JSONResponse:
    overall = psutil.net_io_counters()
    interfaces = _list_interfaces()

    return JSONResponse(
        {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "bytes_sent": overall.bytes_sent,
            "bytes_received": overall.bytes_recv,
            "packets_sent": overall.packets_sent,
            "packets_received": overall.packets_recv,
            "active_interfaces": [interface["name"] for interface in interfaces if interface["is_up"]],
            "interfaces": interfaces,
        }
    )


def _is_private_ip(ip: str) -> bool:
    if not ip or ip in (".", "-", "unknown"):
        return True
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    try:
        a, b, c, d = (int(p) for p in parts)
    except ValueError:
        return False
    if a == 10:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 127:
        return True
    if a == 169 and b == 254:
        return True
    return False


async def _fetch_public_ip_json(client: httpx.AsyncClient, url: str) -> dict[str, Any] | None:
    headers = {
        "User-Agent": "SmartNetworkAnalyzer/1.0 (https://github.com/)",
        "Accept": "application/json",
    }
    response = await client.get(url, headers=headers, follow_redirects=True)
    response.raise_for_status()
    data = response.json()
    if isinstance(data, dict) and data.get("error"):
        return None
    return data


async def _lookup_public_ip_from_server() -> dict[str, Any]:
    """
    Outbound HTTPS from this container. Returns the public IP seen by the provider
    (usually your home/office NAT) plus ISP/geo when available.
    """
    timeout = httpx.Timeout(15.0, connect=10.0)
    headers = {
        "User-Agent": "SmartNetworkAnalyzer/1.0",
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=timeout) as client:
        # 1) ipapi.co (free tier; may block some datacenter IPs without User-Agent)
        try:
            payload = await _fetch_public_ip_json(client, "https://ipapi.co/json/")
            if payload and payload.get("ip"):
                return {
                    "ip": payload.get("ip"),
                    "isp": payload.get("org") or "Unknown",
                    "city": payload.get("city") or "Unknown",
                    "country": payload.get("country_name") or payload.get("country") or "Unknown",
                    "organization": payload.get("org") or "Unknown",
                    "source": "ipapi.co",
                }
        except Exception:
            pass

        # 2) ipinfo.io (no token required for basic JSON)
        try:
            response = await client.get("https://ipinfo.io/json", headers=headers, follow_redirects=True)
            response.raise_for_status()
            payload = response.json()
            if payload.get("ip"):
                org = payload.get("org") or "Unknown"
                return {
                    "ip": payload.get("ip"),
                    "isp": org,
                    "city": payload.get("city") or "Unknown",
                    "country": payload.get("country") or "Unknown",
                    "organization": org,
                    "source": "ipinfo.io",
                }
        except Exception:
            pass

        # 3) ipify + ipapi detail (split in case ipapi /json blocked but /{ip}/json works)
        try:
            r = await client.get("https://api64.ipify.org?format=json", headers=headers, follow_redirects=True)
            r.raise_for_status()
            ip = (r.json() or {}).get("ip")
            if ip:
                detail = await _fetch_public_ip_json(client, f"https://ipapi.co/{ip}/json/")
                if detail and detail.get("ip"):
                    return {
                        "ip": detail.get("ip"),
                        "isp": detail.get("org") or "Unknown",
                        "city": detail.get("city") or "Unknown",
                        "country": detail.get("country_name") or detail.get("country") or "Unknown",
                        "organization": detail.get("org") or "Unknown",
                        "source": "ipify+ipapi",
                    }
                return {
                    "ip": ip,
                    "isp": "Unknown",
                    "city": "Unknown",
                    "country": "Unknown",
                    "organization": "Unknown",
                    "source": "ipify",
                }
        except Exception:
            pass

    return {
        "ip": None,
        "isp": "Unavailable",
        "city": "Unavailable",
        "country": "Unavailable",
        "organization": "Unavailable",
        "source": "unavailable",
        "hint": "Outbound HTTPS to IP lookup services failed. Check Docker DNS/firewall, or use Refresh IP (browser lookup).",
    }


@app.get("/ip")
async def ip_info() -> JSONResponse:
    result = await _lookup_public_ip_from_server()
    result["hostname"] = socket.gethostname()

    # Never expose Docker bridge / private client IP as "public IP"
    if result.get("ip") and _is_private_ip(str(result["ip"])):
        result = {
            "ip": None,
            "isp": "Unavailable",
            "city": "Unavailable",
            "country": "Unavailable",
            "organization": "Unavailable",
            "source": "unavailable",
            "hint": "Lookup returned a private address; use browser-side lookup or check network.",
            "hostname": socket.gethostname(),
        }

    return JSONResponse(result)
