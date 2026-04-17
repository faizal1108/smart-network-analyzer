const API_BASE = "/api";

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
const ispValueEl = document.getElementById("ispValue");
const locationValueEl = document.getElementById("locationValue");
const organizationValueEl = document.getElementById("organizationValue");

let monitorInterval = null;
let previousStats = null;
let speedChart;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function toMbps(bytesPerSecond) {
  return (bytesPerSecond * 8) / 1_000_000;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

function initSpeedChart() {
  const chartContext = document.getElementById("speedChart");
  if (!chartContext || typeof Chart === "undefined") return;
  speedChart = new Chart(chartContext, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "Download Mbps", data: [], borderColor: "#059669", tension: 0.3 },
        { label: "Upload Mbps", data: [], borderColor: "#2563eb", tension: 0.3 },
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
  const maxChunk = 65536; // Web Crypto API limit per call.
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

async function runDownloadTest() {
  const start = performance.now();
  const response = await fetch(`${API_BASE}/download-test?size_mb=20`);
  if (!response.ok) throw new Error("Download test failed");
  const blob = await response.blob();
  const elapsedSec = Math.max((performance.now() - start) / 1000, 0.0001);
  return (blob.size * 8) / elapsedSec / 1_000_000;
}

async function runUploadTest() {
  const uploadBlob = createUploadBlob(2);
  const formData = new FormData();
  formData.append("file", uploadBlob, "upload-test.bin");
  const result = await fetchJson("/upload-test", { method: "POST", body: formData });
  return result.upload_mbps;
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

  try {
    while (performance.now() < endAt) {
      const remaining = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
      speedLoaderTextEl.textContent = `Running speed test... ${remaining}s left`;

      const ping = await runPingTest();
      const download = await runDownloadTest();
      const upload = await runUploadTest();
      pingValueEl.textContent = `${ping.toFixed(2)} ms`;
      downloadValueEl.textContent = `${download.toFixed(2)} Mbps`;
      uploadValueEl.textContent = `${upload.toFixed(2)} Mbps`;
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
  if (monitorInterval) {
    stopMonitoring();
  } else {
    startMonitoring();
  }
});

refreshNetworkBtn.addEventListener("click", () => {
  fetchAndRenderNetworkStats().catch((error) => console.error(error));
});

function applyIpPayload(data) {
  ipValueEl.textContent = data.ip || "—";
  ispValueEl.textContent = data.isp || "—";
  const city = data.city && data.city !== "Unavailable" ? data.city : "";
  const country = data.country && data.country !== "Unavailable" ? data.country : "";
  locationValueEl.textContent = city && country ? `${city}, ${country}` : city || country || "—";
  organizationValueEl.textContent = data.organization || "—";
}

async function fetchIpFromBrowser() {
  const tryUrls = ["https://ipapi.co/json/", "https://ipinfo.io/json"];
  for (const url of tryUrls) {
    try {
      const response = await fetch(url, { mode: "cors" });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload.error) continue;
      if (payload.ip) {
        const org = payload.org || payload.org_name || "Unknown";
        return {
          ip: payload.ip,
          isp: org,
          city: payload.city || "Unknown",
          country: payload.country_name || payload.country || "Unknown",
          organization: org,
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function loadIpInfo() {
  try {
    const data = await fetchJson("/ip");
    const needsClient =
      !data.ip ||
      data.source === "unavailable" ||
      data.isp === "Unavailable" ||
      (typeof data.ip === "string" && data.ip.startsWith("172."));

    if (needsClient) {
      const clientData = await fetchIpFromBrowser();
      if (clientData) {
        applyIpPayload(clientData);
        return;
      }
    }

    applyIpPayload(data);
  } catch {
    const clientData = await fetchIpFromBrowser();
    if (clientData) {
      applyIpPayload(clientData);
    } else {
      ipValueEl.textContent = "Unavailable";
      ispValueEl.textContent = "Unavailable";
      locationValueEl.textContent = "Unavailable";
      organizationValueEl.textContent = "Unavailable";
    }
  }
}

refreshIpBtn.addEventListener("click", loadIpInfo);
startSpeedTestBtn.addEventListener("click", startSpeedTest);
initSpeedChart();
loadIpInfo();
fetchAndRenderNetworkStats().catch((error) => console.error(error));
