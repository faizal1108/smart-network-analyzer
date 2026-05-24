const API_BASE = "https://smart-network-analyzer-1.onrender.com/api";

const toggleMonitorBtn = document.getElementById("toggleMonitorBtn");
const refreshNetworkBtn = document.getElementById("refreshNetworkBtn");
const refreshIpBtn = document.getElementById("refreshIpBtn");
const startSpeedTestBtn = document.getElementById("startSpeedTestBtn");
const speedLoaderEl = document.getElementById("speedLoader");
const speedLoaderTextEl = document.getElementById("speedLoaderText");
const pingValueEl = document.getElementById("pingValue");
const downloadValueEl = document.getElementById("downloadValue");
const uploadValueEl = document.getElementById("uploadValue");
const liveUploadEl = document.getElementById("liveUpload");
const liveDownloadEl = document.getElementById("liveDownload");
const totalSentEl = document.getElementById("totalSent");
const totalReceivedEl = document.getElementById("totalReceived");
const interfaceTableBody = document.getElementById("interfaceTableBody");

const ipValueEl = document.getElementById("ipValue");
const ipv4ValueEl = document.getElementById("ipv4Value");
const ipv6ValueEl = document.getElementById("ipv6Value");
const ispValueEl = document.getElementById("ispValue");
const locationValueEl = document.getElementById("locationValue");
const organizationValueEl = document.getElementById("organizationValue");

let monitorInterval = null;
let previousStats = null;
let speedChart;
let providerMap = null;
let userMarker = null;

// ── Provider Map (IP-based) ──────────────────────────────────────────────────

function initProviderMap() {
  const mapContainer = document.getElementById("providerMap");
  if (!mapContainer || typeof L === "undefined") return;

  providerMap = L.map("providerMap").setView([20, 0], 2);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap",
  }).addTo(providerMap);
}

function updateMapLocation(lat, lon, isp) {
  if (!providerMap) return;

  providerMap.setView([lat, lon], 12);

  if (userMarker) providerMap.removeLayer(userMarker);

  userMarker = L.marker([lat, lon], { title: "Your Location" })
    .addTo(providerMap)
    .bindPopup(`<b>Your Location</b><br/>${isp}`)
    .openPopup();
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function toMbps(bytesPerSecond) {
  return (bytesPerSecond * 8) / 1_000_000;
}

/** Megabits per second (decimal Mbit/s), e.g. 23.5 */
function bytesToMbitPerSec(bytes, elapsedSec) {
  const seconds = Math.max(elapsedSec, 0.001);
  return (bytes * 8) / seconds / 1_000_000;
}

function formatMbitPerSec(mbitPerSec) {
  return `${Number(mbitPerSec).toFixed(1)} Mbit/s`;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

// ── Speed Test ───────────────────────────────────────────────────────────────

function initSpeedChart() {
  const chartContext = document.getElementById("speedChart");
  if (!chartContext || typeof Chart === "undefined") return;
  speedChart = new Chart(chartContext, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Download Mbit/s", data: [], borderColor: "#059669", tension: 0.3 },
        { label: "Upload Mbit/s", data: [], borderColor: "#2563eb", tension: 0.3 },
        { label: "Ping ms", data: [], borderColor: "#b45309", tension: 0.3 },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function addSpeedPoint({ ping, download, upload }) {
  if (!speedChart) return;
  speedChart.data.labels.push(new Date().toLocaleTimeString());
  speedChart.data.datasets[0].data.push(download);
  speedChart.data.datasets[1].data.push(upload);
  speedChart.data.datasets[2].data.push(ping);
  if (speedChart.data.labels.length > 10) {
    speedChart.data.labels.shift();
    speedChart.data.datasets.forEach((dataset) => dataset.data.shift());
  }
  speedChart.update();
}

function createUploadBlob(sizeMb = 5) {
  const totalBytes = sizeMb * 1024 * 1024;
  const maxChunk = 65536;
  const bytes = new Uint8Array(totalBytes);
  for (let offset = 0; offset < totalBytes; offset += maxChunk) {
    const end = Math.min(offset + maxChunk, totalBytes);
    crypto.getRandomValues(bytes.subarray(offset, end));
  }
  return new Blob([bytes], { type: "application/octet-stream" });
}

async function runPingTest() {
  const start = performance.now();
  await fetchJson("/ping");
  return performance.now() - start;
}

const SPEED_TEST_SIZE_MB = 10;

async function runDownloadTest() {
  const start = performance.now();
  const response = await fetch(`${API_BASE}/download-test?size_mb=${SPEED_TEST_SIZE_MB}`);
  if (!response.ok) throw new Error("Download test failed");

  let receivedBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
    }
  } else {
    const blob = await response.blob();
    receivedBytes = blob.size;
  }

  const elapsedSec = (performance.now() - start) / 1000;
  return bytesToMbitPerSec(receivedBytes, elapsedSec);
}

async function runUploadTest() {
  const uploadBlob = createUploadBlob(SPEED_TEST_SIZE_MB);
  const formData = new FormData();
  formData.append("file", uploadBlob, "upload-test.bin");

  const start = performance.now();
  const response = await fetch(`${API_BASE}/upload-test`, { method: "POST", body: formData });
  if (!response.ok) throw new Error("Upload test failed");
  await response.json();

  const elapsedSec = (performance.now() - start) / 1000;
  return bytesToMbitPerSec(uploadBlob.size, elapsedSec);
}

async function startSpeedTest() {
  const durationSeconds = 10;
  startSpeedTestBtn.disabled = true;
  startSpeedTestBtn.classList.add("opacity-60");
  speedLoaderEl.classList.remove("hidden");
  speedLoaderEl.classList.add("flex");
  startSpeedTestBtn.textContent = `Running ${durationSeconds}s Test`;

  const startedAt = performance.now();
  const endAt = startedAt + durationSeconds * 1000;

  const downloadSamples = [];
  const uploadSamples = [];

  try {
    while (performance.now() < endAt) {
      const remaining = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
      speedLoaderTextEl.textContent = `Running speed test... ${remaining}s left`;

      const ping = await runPingTest();
      downloadSamples.push(await runDownloadTest());
      uploadSamples.push(await runUploadTest());

      const download =
        downloadSamples.reduce((sum, value) => sum + value, 0) / downloadSamples.length;
      const upload =
        uploadSamples.reduce((sum, value) => sum + value, 0) / uploadSamples.length;

      pingValueEl.textContent = `${ping.toFixed(2)} ms`;
      downloadValueEl.textContent = formatMbitPerSec(download);
      uploadValueEl.textContent = formatMbitPerSec(upload);
      addSpeedPoint({ ping, download, upload });
    }
  } catch (error) {
    alert(`Speed test failed: ${error.message}`);
  } finally {
    startSpeedTestBtn.disabled = false;
    startSpeedTestBtn.classList.remove("opacity-60");
    startSpeedTestBtn.textContent = "Start Test";
    speedLoaderTextEl.textContent = "Running speed test...";
    speedLoaderEl.classList.add("hidden");
    speedLoaderEl.classList.remove("flex");
  }
}

// ── Network Interfaces ───────────────────────────────────────────────────────

function interfaceIcon(type) {
  if (type === "wifi") return "📶";
  if (type === "ethernet") return "🔌";
  return "🌐";
}

function renderInterfaceTable(currentInterfaces, previousInterfaceMap) {
  interfaceTableBody.innerHTML = "";
  if (!currentInterfaces.length) {
    interfaceTableBody.innerHTML = `<tr><td colspan="6" class="px-3 py-4 text-slate-500">No interfaces found.</td></tr>`;
    return;
  }

  currentInterfaces.forEach((networkInterface) => {
    const prev = previousInterfaceMap.get(networkInterface.name);
    const upBps = prev ? Math.max(0, networkInterface.bytes_sent - prev.bytes_sent) : 0;
    const downBps = prev ? Math.max(0, networkInterface.bytes_received - prev.bytes_received) : 0;

    const tr = document.createElement("tr");
    tr.className = networkInterface.is_up ? "bg-emerald-50" : "bg-white";
    tr.innerHTML = `
      <td class="px-3 py-2">${interfaceIcon(networkInterface.type)}</td>
      <td class="px-3 py-2 font-medium text-slate-700">${networkInterface.name}</td>
      <td class="px-3 py-2 text-slate-600">${networkInterface.ip}</td>
      <td class="px-3 py-2">
        <span class="rounded-full px-2 py-1 text-xs ${networkInterface.is_up ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}">
          ${networkInterface.status}
        </span>
      </td>
      <td class="px-3 py-2 text-blue-700">${toMbps(upBps).toFixed(2)} Mbps</td>
      <td class="px-3 py-2 text-emerald-700">${toMbps(downBps).toFixed(2)} Mbps</td>
    `;
    interfaceTableBody.appendChild(tr);
  });
}

async function fetchAndRenderNetworkStats() {
  const stats = await fetchJson("/network-stats");
  totalSentEl.textContent = formatBytes(stats.bytes_sent);
  totalReceivedEl.textContent = formatBytes(stats.bytes_received);

  const previousInterfaceMap = new Map();
  if (previousStats) {
    const seconds = 1;
    const sentPerSec = Math.max(0, stats.bytes_sent - previousStats.bytes_sent) / seconds;
    const recvPerSec = Math.max(0, stats.bytes_received - previousStats.bytes_received) / seconds;
    liveUploadEl.textContent = `${toMbps(sentPerSec).toFixed(2)} Mbps`;
    liveDownloadEl.textContent = `${toMbps(recvPerSec).toFixed(2)} Mbps`;
    previousStats.interfaces.forEach((item) => previousInterfaceMap.set(item.name, item));
  }
  renderInterfaceTable(stats.interfaces, previousInterfaceMap);
  previousStats = stats;
}

function startMonitoring() {
  if (monitorInterval) return;
  toggleMonitorBtn.textContent = "Stop Monitoring";
  toggleMonitorBtn.classList.remove("bg-blue-600");
  toggleMonitorBtn.classList.add("bg-red-600", "hover:bg-red-500");
  fetchAndRenderNetworkStats().catch((error) => console.error(error));
  monitorInterval = setInterval(() => {
    fetchAndRenderNetworkStats().catch((error) => console.error(error));
  }, 1000);
}

function stopMonitoring() {
  if (!monitorInterval) return;
  clearInterval(monitorInterval);
  monitorInterval = null;
  toggleMonitorBtn.textContent = "Start Monitoring";
  toggleMonitorBtn.classList.add("bg-blue-600");
  toggleMonitorBtn.classList.remove("bg-red-600", "hover:bg-red-500");
}

toggleMonitorBtn.addEventListener("click", () => {
  monitorInterval ? stopMonitoring() : startMonitoring();
});

refreshNetworkBtn.addEventListener("click", () => {
  fetchAndRenderNetworkStats().catch((error) => console.error(error));
});

// ── IP Info — always resolved browser-side to get real public IP ─────────────
// The backend runs inside Docker, so /api/ip sees an internal 10.x or 172.x
// address. Fetching from the browser hits ipapi.co/ipinfo.io directly, which
// sees the real public IPv4 or IPv6 assigned by the ISP.

function applyIpPayload(data) {
  if (ipValueEl) {
    ipValueEl.textContent = data.ip || data.ipv4 || data.ipv6 || "—";
  }
  ispValueEl.textContent = data.isp || "Unknown";
  const city = data.city || "";
  const country = data.country || "";
  locationValueEl.textContent = city && country ? `${city}, ${country}` : city || country || "Unknown";
  organizationValueEl.textContent = data.organization || "Unknown";

  if (data.lat != null && data.lon != null) {
    updateMapLocation(parseFloat(data.lat), parseFloat(data.lon), data.isp || "Provider");
  } else if (data.loc) {
    const [la, lo] = data.loc.split(",").map(Number);
    if (!isNaN(la) && !isNaN(lo)) updateMapLocation(la, lo, data.isp || "Provider");
  }
}

async function getIPv4() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    if (!res.ok) throw new Error("IPv4 request failed");
    const data = await res.json();
    return data.ip || "Unavailable";
  } catch {
    return "Unavailable";
  }
}

async function getIPv6() {
  try {
    const res = await fetch("https://api64.ipify.org?format=json");
    if (!res.ok) throw new Error("IPv6 request failed");
    const data = await res.json();
    if (data.ip && data.ip.includes(":")) {
      return data.ip;
    }
    return "IPv6 unavailable";
  } catch {
    return "IPv6 unavailable";
  }
}

async function getGeoData() {
  const sources = [
    "https://ipapi.co/json/",
    "https://ipinfo.io/json",
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) continue;
      const p = await res.json();

      if (url.includes("ipapi")) {
        return {
          isp: p.org || "Unknown",
          organization: p.org || "Unknown",
          city: p.city || "",
          country: p.country_name || p.country || "",
          lat: p.latitude ?? null,
          lon: p.longitude ?? null,
        };
      }

      let lat = null;
      let lon = null;
      if (p.loc) {
        [lat, lon] = p.loc.split(",").map(Number);
      }

      return {
        isp: p.org || "Unknown",
        organization: p.org || "Unknown",
        city: p.city || "",
        country: p.country || "",
        lat,
        lon,
      };
    } catch {
      continue;
    }
  }

  return null;
}

async function loadIpInfo() {
  ipv4ValueEl.textContent = "Loading...";
  ipv6ValueEl.textContent = "Loading...";
  ispValueEl.textContent = "Loading...";
  locationValueEl.textContent = "Loading...";
  organizationValueEl.textContent = "Loading...";

  try {
    const [ipv4, ipv6, geo] = await Promise.all([getIPv4(), getIPv6(), getGeoData()]);

    ipv4ValueEl.textContent = ipv4;
    ipv6ValueEl.textContent = ipv6;

    if (geo) {
      applyIpPayload(geo);
    } else {
      ispValueEl.textContent = "Unavailable";
      locationValueEl.textContent = "Unavailable";
      organizationValueEl.textContent = "Unavailable";
    }
  } catch (err) {
    console.error(err);
    ipv4ValueEl.textContent = "Error";
    ipv6ValueEl.textContent = "Error";
    ispValueEl.textContent = "Error";
    locationValueEl.textContent = "Error";
    organizationValueEl.textContent = "Error";
  }
}

refreshIpBtn.addEventListener("click", loadIpInfo);

setInterval(loadIpInfo, 30_000);

startSpeedTestBtn.addEventListener("click", startSpeedTest);

// ── My Location — watchPosition for continuous live updates ──────────────────

(function initLocationFeature() {
  const getLocationBtn      = document.getElementById("getLocationBtn");
  const locationStatus      = document.getElementById("locationStatus");
  const locationInfo        = document.getElementById("locationInfo");
  const locationMapWrapper  = document.getElementById("locationMapWrapper");
  const locationPlaceholder = document.getElementById("locationPlaceholder");
  const latEl               = document.getElementById("latValue");
  const lngEl               = document.getElementById("lngValue");
  const accuracyEl          = document.getElementById("accuracyValue");
  const addressEl           = document.getElementById("addressValue");

  if (!getLocationBtn) return;

  let locationMap     = null;
  let locationMarker  = null;
  let accuracyCircle  = null;
  let watchId         = null;
  let lastGeocode     = "";

  // ── helpers ──────────────────────────────────────────────
  function showStatus(msg, type = "info") {
    const colors = {
      info:    "background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe",
      error:   "background:#fef2f2;color:#b91c1c;border:1px solid #fecaca",
      success: "background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0",
      live:    "background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe",
    };
    locationStatus.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;font-size:0.875rem;margin-bottom:12px;${colors[type]}`;
    locationStatus.innerHTML = type === "live"
      ? `<span style="width:8px;height:8px;border-radius:50%;background:#7c3aed;animation:locpulse 1.5s infinite;flex-shrink:0"></span>${msg}`
      : msg;
  }

  function hideStatus() {
    locationStatus.style.display = "none";
  }

  function setButtonTracking(tracking) {
    if (tracking) {
      getLocationBtn.style.background = "#ef4444";
      getLocationBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
        Stop Tracking`;
    } else {
      getLocationBtn.style.background = "";
      getLocationBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        Locate Me`;
    }
  }

  // ── reverse geocode (throttled) ──────────────────────────
  async function reverseGeocode(lat, lng) {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (key === lastGeocode) return null;
    lastGeocode = key;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
        { headers: { "Accept-Language": "en" } }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.display_name || null;
    } catch { return null; }
  }

  // ── Leaflet map ──────────────────────────────────────────
  function renderLocationMap(lat, lng, accuracy) {
    locationMapWrapper.style.display = "block";

    if (!locationMap) {
      locationMap = L.map("locationMap").setView([lat, lng], 16);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(locationMap);
    } else {
      locationMap.panTo([lat, lng]);
    }

    const pulseIcon = L.divIcon({
      className: "",
      html: `
        <div style="position:relative;width:24px;height:24px;">
          <div style="position:absolute;inset:0;border-radius:50%;
            background:rgba(37,99,235,0.2);animation:locpulse 1.8s infinite;"></div>
          <div style="position:absolute;inset:5px;border-radius:50%;
            background:#2563eb;border:2.5px solid #fff;
            box-shadow:0 1px 5px rgba(0,0,0,0.4);"></div>
        </div>
        <style>
          @keyframes locpulse{0%,100%{transform:scale(1);opacity:.6}50%{transform:scale(2.2);opacity:.1}}
        </style>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    if (locationMarker) locationMap.removeLayer(locationMarker);
    if (accuracyCircle) locationMap.removeLayer(accuracyCircle);

    locationMarker = L.marker([lat, lng], { icon: pulseIcon })
      .addTo(locationMap)
      .bindPopup(`<b>You are here</b><br>±${Math.round(accuracy)} m`)
      .openPopup();

    if (accuracy > 5) {
      accuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: "#2563eb",
        fillColor: "#3b82f6",
        fillOpacity: 0.07,
        weight: 1,
      }).addTo(locationMap);
    }

    setTimeout(() => locationMap.invalidateSize(), 150);
  }

  // ── watchPosition callbacks ──────────────────────────────
  async function onPosition(position) {
    const { latitude, longitude, accuracy } = position.coords;

    // Show info grid, hide placeholder
    locationInfo.style.display = "grid";
    locationPlaceholder.style.display = "none";

    latEl.textContent      = latitude.toFixed(6) + "°";
    lngEl.textContent      = longitude.toFixed(6) + "°";
    accuracyEl.textContent = `±${Math.round(accuracy)} m`;

    renderLocationMap(latitude, longitude, accuracy);
    showStatus(`Live tracking · updated ${new Date().toLocaleTimeString()}`, "live");

    const address = await reverseGeocode(latitude, longitude);
    if (address) addressEl.textContent = address;
    else if (addressEl.textContent === "—") addressEl.textContent = "Fetching address…";
  }

  function onError(err) {
    stopTracking();
    const messages = {
      1: "Permission denied — allow location access in your browser settings.",
      2: "Position unavailable — check device GPS or network.",
      3: "Location request timed out. Try again.",
    };
    showStatus(messages[err.code] || "Geolocation error.", "error");
  }

  function startTracking() {
    if (!navigator.geolocation) {
      showStatus("Geolocation is not supported by your browser.", "error");
      return;
    }
    showStatus("Waiting for location permission…", "info");
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
    setButtonTracking(true);
  }

  function stopTracking() {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
    setButtonTracking(false);
    showStatus("Tracking stopped.", "info");
    setTimeout(hideStatus, 2000);
  }

  getLocationBtn.addEventListener("click", () => {
    watchId !== null ? stopTracking() : startTracking();
  });
})();

// ── Init ──────────────────────────────────────────────────────────────────────

initSpeedChart();
initProviderMap();
loadIpInfo();
fetchAndRenderNetworkStats().catch((error) => console.error(error));

// NEW FEATURE START

const stabilityPingValueEl = document.getElementById("stabilityPingValue");
const stabilityJitterValueEl = document.getElementById("stabilityJitterValue");
const stabilityPacketLossValueEl = document.getElementById("stabilityPacketLossValue");
const stabilityScoreValueEl = document.getElementById("stabilityScoreValue");
const stabilityStatusValueEl = document.getElementById("stabilityStatusValue");
const stabilityQualityBadgeEl = document.getElementById("stabilityQualityBadge");
const websitePingInputEl = document.getElementById("websitePingInput");
const websitePingBtnEl = document.getElementById("websitePingBtn");
const websitePingHostEl = document.getElementById("websitePingHost");
const websitePingLatencyEl = document.getElementById("websitePingLatency");
const websitePingStatusEl = document.getElementById("websitePingStatus");
const websitePingHistoryBodyEl = document.getElementById("websitePingHistoryBody");
const securityScoreValueEl = document.getElementById("securityScoreValue");
const securityGaugeRingEl = document.getElementById("securityGaugeRing");
const securityVpnValueEl = document.getElementById("securityVpnValue");
const securityProxyValueEl = document.getElementById("securityProxyValue");
const securityRiskValueEl = document.getElementById("securityRiskValue");
const securityOpenPortsValueEl = document.getElementById("securityOpenPortsValue");

let stabilityPingChart = null;
let stabilityInterval = null;
const websitePingHistory = [];

function stabilityQualityColors(quality) {
  const map = {
    Excellent: { badge: "bg-emerald-100 text-emerald-700", text: "text-emerald-700" },
    Good: { badge: "bg-yellow-100 text-yellow-700", text: "text-yellow-700" },
    Fair: { badge: "bg-orange-100 text-orange-700", text: "text-orange-700" },
    Poor: { badge: "bg-red-100 text-red-700", text: "text-red-700" },
  };
  return map[quality] || { badge: "bg-slate-100 text-slate-600", text: "text-slate-700" };
}

function initStabilityPingChart() {
  const chartContext = document.getElementById("stabilityPingChart");
  if (!chartContext || typeof Chart === "undefined") return;
  stabilityPingChart = new Chart(chartContext, {
    type: "line",
    data: {
      labels: [],
      datasets: [{ label: "Ping ms", data: [], borderColor: "#b45309", tension: 0.3, fill: false }],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });
}

function addStabilityPingPoint(pingMs) {
  if (!stabilityPingChart) return;
  stabilityPingChart.data.labels.push(new Date().toLocaleTimeString());
  stabilityPingChart.data.datasets[0].data.push(pingMs);
  if (stabilityPingChart.data.labels.length > 20) {
    stabilityPingChart.data.labels.shift();
    stabilityPingChart.data.datasets[0].data.shift();
  }
  stabilityPingChart.update();
}

function renderStability(data) {
  const quality = data.quality || data.network_status || "—";
  const colors = stabilityQualityColors(quality);

  stabilityPingValueEl.textContent = `${Number(data.ping || 0).toFixed(1)} ms`;
  stabilityJitterValueEl.textContent = `${Number(data.jitter || 0).toFixed(1)} ms`;
  stabilityPacketLossValueEl.textContent = `${Number(data.packet_loss || 0).toFixed(1)} %`;
  stabilityScoreValueEl.textContent = `${data.connection_quality_score ?? "—"}`;
  stabilityStatusValueEl.textContent = quality;
  stabilityStatusValueEl.className = `text-lg font-semibold ${colors.text}`;

  stabilityQualityBadgeEl.textContent = quality;
  stabilityQualityBadgeEl.className = `rounded-full px-3 py-1 text-xs font-semibold ${colors.badge}`;

  addStabilityPingPoint(Number(data.ping || 0));
}

async function fetchStability() {
  try {
    const data = await fetchJson("/network-stability");
    renderStability(data);
  } catch (error) {
    console.error(error);
  }
}

function startStabilityMonitor() {
  if (stabilityInterval) return;
  fetchStability();
  stabilityInterval = setInterval(() => {
    fetchStability().catch((error) => console.error(error));
  }, 1000);
}

function renderWebsitePingResult(result) {
  websitePingHostEl.textContent = result.host || "—";
  websitePingLatencyEl.textContent =
    result.latency != null ? `${Number(result.latency).toFixed(1)} ms` : "—";
  const online = result.reachable && result.status === "Online";
  websitePingStatusEl.textContent = online ? "🟢 Online" : "🔴 Offline";
  websitePingStatusEl.className = `text-sm font-semibold ${online ? "text-emerald-700" : "text-red-700"}`;
}

function renderWebsitePingHistory() {
  if (!websitePingHistory.length) {
    websitePingHistoryBodyEl.innerHTML =
      '<tr><td colspan="3" class="px-3 py-4 text-slate-500">No tests yet.</td></tr>';
    return;
  }

  websitePingHistoryBodyEl.innerHTML = websitePingHistory
    .map((item) => {
      const online = item.reachable && item.status === "Online";
      return `
        <tr class="border-t border-slate-100">
          <td class="px-3 py-2 font-medium text-slate-700">${item.host}</td>
          <td class="px-3 py-2 text-amber-700">${item.latency != null ? `${Number(item.latency).toFixed(1)} ms` : "—"}</td>
          <td class="px-3 py-2 ${online ? "text-emerald-700" : "text-red-700"}">${online ? "🟢 Online" : "🔴 Offline"}</td>
        </tr>`;
    })
    .join("");
}

async function runWebsitePingTest() {
  const host = (websitePingInputEl.value || "").trim();
  if (!host) {
    alert("Enter a website to test.");
    return;
  }

  websitePingBtnEl.disabled = true;
  websitePingBtnEl.classList.add("opacity-60");
  try {
    const result = await fetchJson("/website-ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host }),
    });
    renderWebsitePingResult(result);
    websitePingHistory.unshift(result);
    if (websitePingHistory.length > 10) websitePingHistory.pop();
    renderWebsitePingHistory();
  } catch (error) {
    alert(`Website ping failed: ${error.message}`);
  } finally {
    websitePingBtnEl.disabled = false;
    websitePingBtnEl.classList.remove("opacity-60");
  }
}

function securityScoreColor(score) {
  if (score <= 30) return "#dc2626";
  if (score <= 70) return "#ca8a04";
  return "#059669";
}

function renderSecurityScore(data) {
  const score = Number(data.score || 0);
  securityScoreValueEl.textContent = `${score}/100`;
  securityScoreValueEl.style.color = securityScoreColor(score);

  const filledDeg = Math.round((score / 100) * 360);
  const color = securityScoreColor(score);
  securityGaugeRingEl.style.background = `conic-gradient(${color} 0deg ${filledDeg}deg, #e2e8f0 ${filledDeg}deg 360deg)`;

  securityVpnValueEl.textContent = data.vpn ? "Detected" : "Not detected";
  securityProxyValueEl.textContent = data.proxy ? "Detected" : "Not detected";
  securityOpenPortsValueEl.textContent =
    Array.isArray(data.open_ports) && data.open_ports.length
      ? data.open_ports.join(", ")
      : "None detected";

  const risk = data.risk || "—";
  const riskColors = { Low: "text-emerald-700", Medium: "text-yellow-700", High: "text-red-700" };
  securityRiskValueEl.textContent = risk;
  securityRiskValueEl.className = `font-semibold ${riskColors[risk] || "text-slate-700"}`;
}

async function loadSecurityScore() {
  try {
    const data = await fetchJson("/security-score");
    renderSecurityScore(data);
  } catch (error) {
    console.error(error);
  }
}

if (stabilityPingValueEl && websitePingBtnEl && securityScoreValueEl) {
  initStabilityPingChart();
  startStabilityMonitor();
  loadSecurityScore();

  websitePingBtnEl.addEventListener("click", () => {
    runWebsitePingTest().catch((error) => console.error(error));
  });
  websitePingInputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      runWebsitePingTest().catch((error) => console.error(error));
    }
  });
}

// NEW FEATURE END