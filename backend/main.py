import asyncio
import platform
import re
import socket
import statistics
import subprocess
import time
from collections import deque
from datetime import datetime, timezone
from threading import Lock
from typing import AsyncGenerator
from typing import Any

import httpx
import psutil
from fastapi import FastAPI, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
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
    # Minimum 1 ms avoids divide-by-near-zero on fast local uploads (bogus Gbit/s values).
    elapsed = max(time.perf_counter() - start, 0.001)
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


# NEW FEATURE START

STABILITY_PING_HOST = "8.8.8.8"
WEBSITE_PING_TIMEOUT_SEC = 3.0
_WEBSITE_CHECK_PORTS = (443, 80)
_IPV4_PATTERN = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")
_SECURITY_SCAN_PORTS = [21, 22, 23, 80, 443, 445, 3389, 8080, 8443, 5900]
_RISKY_PORTS = {21, 23, 135, 139, 445, 3389, 5900, 6379, 27017}
_VPN_KEYWORDS = ("vpn", "nordvpn", "expressvpn", "mullvad", "proton", "surfshark", "private internet")
_PROXY_KEYWORDS = ("proxy", "squid", "datacenter", "hosting")

_stability_lock = Lock()
_stability_latencies: deque[float] = deque(maxlen=30)
_stability_timeouts = 0
_stability_attempts = 0


class WebsitePingRequest(BaseModel):
    host: str = Field(..., min_length=1, max_length=253)


def _normalize_host(host: str) -> str:
    cleaned = host.strip().lower()
    cleaned = re.sub(r"^https?://", "", cleaned)
    cleaned = cleaned.split("/")[0].split(":")[0]
    return cleaned


def _parse_ping_latency_ms(output: str) -> float | None:
    match = re.search(r"time[=<](\d+(?:\.\d+)?)\s*ms", output, re.IGNORECASE)
    if match:
        return float(match.group(1))
    return None


def _tcp_latency_ms(host: str, port: int = 53, timeout_sec: float = 2.0) -> tuple[bool, float | None]:
    start = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout_sec):
            return True, (time.perf_counter() - start) * 1000
    except OSError:
        return False, None


def _icmp_ping_once(host: str, timeout_sec: float = 2.0) -> tuple[bool, float | None]:
    system = platform.system().lower()
    if system == "windows":
        cmd = ["ping", "-n", "1", "-w", str(int(timeout_sec * 1000)), host]
    else:
        wait_sec = max(1, int(timeout_sec))
        cmd = ["ping", "-c", "1", "-W", str(wait_sec), host]

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_sec + 1.5,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return _tcp_latency_ms(host, port=53, timeout_sec=timeout_sec)

    if completed.returncode != 0:
        return _tcp_latency_ms(host, port=53, timeout_sec=timeout_sec)

    latency = _parse_ping_latency_ms(completed.stdout or "")
    if latency is None:
        latency = _parse_ping_latency_ms(completed.stderr or "")
    if latency is None:
        return _tcp_latency_ms(host, port=53, timeout_sec=timeout_sec)
    return True, latency


def _compute_jitter(latencies: list[float]) -> float:
    if len(latencies) < 2:
        return 0.0
    deltas = [abs(latencies[i] - latencies[i - 1]) for i in range(1, len(latencies))]
    return round(statistics.mean(deltas), 2)


def _stability_quality(ping_ms: float, packet_loss: float) -> str:
    if ping_ms < 50 and packet_loss < 2:
        return "Excellent"
    if ping_ms < 100:
        return "Good"
    if ping_ms < 150:
        return "Fair"
    return "Poor"


def _connection_quality_score(ping_ms: float, packet_loss: float, jitter: float) -> int:
    score = 100.0
    score -= min(ping_ms * 0.35, 45)
    score -= min(packet_loss * 4, 35)
    score -= min(jitter * 0.5, 15)
    return int(max(0, min(100, round(score))))


def _record_stability_sample(success: bool, latency_ms: float | None) -> dict[str, Any]:
    global _stability_timeouts, _stability_attempts

    with _stability_lock:
        _stability_attempts += 1
        if success and latency_ms is not None:
            _stability_latencies.append(latency_ms)
        else:
            _stability_timeouts += 1

        latencies = list(_stability_latencies)
        attempts = max(_stability_attempts, 1)
        packet_loss = round((_stability_timeouts / attempts) * 100, 2)
        current_ping = round(latencies[-1], 2) if latencies else 0.0
        avg_ping = round(statistics.mean(latencies), 2) if latencies else 0.0
        jitter = _compute_jitter(latencies)
        quality = _stability_quality(current_ping, packet_loss)
        score = _connection_quality_score(current_ping, packet_loss, jitter)

    return {
        "ping": current_ping,
        "average_latency": avg_ping,
        "jitter": jitter,
        "packet_loss": packet_loss,
        "timeout_count": _stability_timeouts,
        "quality": quality,
        "connection_quality_score": score,
        "network_status": quality,
    }


def _scan_local_open_ports() -> list[int]:
    open_ports: list[int] = []
    for port in _SECURITY_SCAN_PORTS:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(0.25)
        try:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                open_ports.append(port)
        finally:
            sock.close()
    return sorted(open_ports)


def _detect_vpn_proxy(org_text: str) -> tuple[bool, bool]:
    lowered = org_text.lower()
    vpn = any(keyword in lowered for keyword in _VPN_KEYWORDS)
    proxy = any(keyword in lowered for keyword in _PROXY_KEYWORDS)
    return vpn, proxy


def _security_risk_level(score: int) -> str:
    if score >= 71:
        return "Low"
    if score >= 31:
        return "Medium"
    return "High"


async def _ping_host_async(host: str, timeout_sec: float = WEBSITE_PING_TIMEOUT_SEC) -> tuple[bool, float | None]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _icmp_ping_once, host, timeout_sec)


def _website_reachability_check(host: str, timeout_sec: float = WEBSITE_PING_TIMEOUT_SEC) -> tuple[bool, float | None]:
    """
    Websites are often online on HTTP/HTTPS but block ICMP ping.
    Try TCP 443/80 first; fall back to ICMP for IPs like 8.8.8.8.
    """
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        return False, None

    if not infos:
        return False, None

    addresses: list[str] = []
    seen: set[str] = set()
    for info in infos:
        ip = info[4][0]
        if ip not in seen:
            seen.add(ip)
            addresses.append(ip)

    per_try_timeout = max(timeout_sec / len(_WEBSITE_CHECK_PORTS), 1.5)
    best_latency: float | None = None

    for ip in addresses:
        for port in _WEBSITE_CHECK_PORTS:
            ok, latency_ms = _tcp_latency_ms(ip, port=port, timeout_sec=per_try_timeout)
            if ok and latency_ms is not None:
                if best_latency is None or latency_ms < best_latency:
                    best_latency = latency_ms

    if best_latency is not None:
        return True, best_latency

    if _IPV4_PATTERN.match(host):
        ok, latency_ms = _icmp_ping_once(host, timeout_sec)
        if ok and latency_ms is not None:
            return True, latency_ms
        ok, latency_ms = _tcp_latency_ms(host, port=53, timeout_sec=per_try_timeout)
        if ok and latency_ms is not None:
            return True, latency_ms

    ok, latency_ms = _icmp_ping_once(host, timeout_sec)
    if ok and latency_ms is not None:
        return True, latency_ms

    return False, None


async def _website_reachability_async(
    host: str, timeout_sec: float = WEBSITE_PING_TIMEOUT_SEC
) -> tuple[bool, float | None]:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _website_reachability_check, host, timeout_sec)


@app.get("/network-stability")
async def network_stability() -> JSONResponse:
    success, latency_ms = await _ping_host_async(STABILITY_PING_HOST, timeout_sec=2.0)
    payload = _record_stability_sample(success, latency_ms)
    return JSONResponse(payload)


@app.post("/website-ping")
async def website_ping(body: WebsitePingRequest) -> JSONResponse:
    host = _normalize_host(body.host)
    if not host or not re.match(r"^[a-z0-9.-]+$", host):
        return JSONResponse(
            {
                "host": body.host,
                "reachable": False,
                "latency": None,
                "status": "Offline",
            },
            status_code=400,
        )

    try:
        socket.getaddrinfo(host, None)
    except socket.gaierror:
        return JSONResponse(
            {
                "host": host,
                "reachable": False,
                "latency": None,
                "status": "Offline",
            }
        )

    success, latency_ms = await _website_reachability_async(host, timeout_sec=WEBSITE_PING_TIMEOUT_SEC)
    if success and latency_ms is not None:
        return JSONResponse(
            {
                "host": host,
                "reachable": True,
                "latency": round(latency_ms, 2),
                "status": "Online",
            }
        )

    return JSONResponse(
        {
            "host": host,
            "reachable": False,
            "latency": None,
            "status": "Offline",
        }
    )


@app.get("/security-score")
async def security_score() -> JSONResponse:
    score = 100
    ip_data = await _lookup_public_ip_from_server()
    public_ip = str(ip_data.get("ip") or "")
    is_public_ip = bool(public_ip) and not _is_private_ip(public_ip)
    is_private_network = not is_public_ip

    org_text = f"{ip_data.get('isp', '')} {ip_data.get('organization', '')}"
    vpn, proxy = _detect_vpn_proxy(org_text)

    open_ports = _scan_local_open_ports()
    for port in open_ports:
        if port in _RISKY_PORTS:
            score -= 10

    if proxy:
        score -= 15
    if vpn:
        score += 10
    if is_private_network:
        score += 5

    interfaces = _list_interfaces()
    active = [iface for iface in interfaces if iface["is_up"]]
    has_wifi = any(iface["type"] == "wifi" for iface in active)
    has_ethernet = any(iface["type"] == "ethernet" for iface in active)
    if not has_wifi and not has_ethernet and active:
        score -= 5

    https_ok = False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get("https://www.google.com", follow_redirects=True)
            https_ok = response.status_code < 500
    except Exception:
        https_ok = False
    if not https_ok:
        score -= 5

    score = max(0, min(100, score))
    risk = _security_risk_level(score)

    return JSONResponse(
        {
            "score": score,
            "vpn": vpn,
            "proxy": proxy,
            "open_ports": open_ports,
            "risk": risk,
            "public_ip": is_public_ip,
            "private_network": is_private_network,
            "https": https_ok,
            "network_type": "wifi" if has_wifi else ("ethernet" if has_ethernet else "other"),
        }
    )

# NEW FEATURE END
