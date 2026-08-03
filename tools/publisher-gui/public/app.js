const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatNumber = new Intl.NumberFormat("en-US");
const formatDate = (value, options = { month: "short", day: "numeric", year: "numeric" }) => {
  if (!value) return "Unknown";
  const date = new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString(undefined, options);
};

let appState = null;
let sourceSelection = new Set();
let sourceInitialized = false;
let activeQueue = "unprocessed";
let queueSelection = new Set();
let lastSeenJobId = null;
let lastOpenedLinksKey = null;
let lastQueueKey = null;
let lastHistoryKey = null;
let polling = null;
let toastTimer = null;

function localIso(date) {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10);
}

function setDefaultDates() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const start = new Date(yesterday);
  start.setDate(start.getDate() - 6);
  $("#startDate").value = localIso(start);
  $("#endDate").value = localIso(yesterday);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
  return data;
}

async function post(url, value = {}) {
  return request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.className = "toast"; }, 3800);
}

function navigate(view) {
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$(".view").forEach((section) => section.classList.toggle("active", section.id === `view-${view}`));
  const copy = {
    run: ["PUBLISHING WORKFLOW", "Create a new edition", "Collect local reporting, prepare drafts, and choose when they go live."],
    queue: ["EDITORIAL WORKSPACE", "Keep the edition moving", "Process collected stories, review rewrite drafts, or deploy selected work."],
    history: ["COLLECTION RECORD", "Scrape history", "A complete audit trail of dates, sites, limits, outcomes, and storage."],
  }[view];
  $("#viewKicker").textContent = copy[0];
  $("#viewTitle").textContent = copy[1];
  $("#viewSubtitle").textContent = copy[2];
  location.hash = view;
}

function updateSummary() {
  const start = $("#startDate").value;
  const end = $("#endDate").value;
  let days = "—";
  if (start && end) {
    days = Math.floor((new Date(`${end}T12:00:00`) - new Date(`${start}T12:00:00`)) / 86_400_000) + 1;
  }
  $("#dayCount").textContent = days > 0 ? days : "—";
  $("#summaryDates").textContent = start && end ? `${formatDate(start, { month: "short", day: "numeric" })} – ${formatDate(end, { month: "short", day: "numeric" })}` : "—";
  const total = appState?.sources.length || sourceSelection.size;
  $("#summarySources").textContent = sourceSelection.size === total ? `All ${total}` : `${sourceSelection.size} selected`;
  $("#summaryLimit").textContent = `${$("#limit").value || 0} per site`;
  $("#summaryMedia").textContent = $("#includeImages").checked ? "Source photos" : "House illustration";
  $("#runBtn").disabled = !start || !end || sourceSelection.size === 0 || Boolean(appState?.job?.status === "running");
}

function renderSources() {
  if (!appState) return;
  const query = $("#sourceSearch").value.trim().toLowerCase();
  const sources = appState.sources.filter((source) => `${source.name} ${source.id} ${source.group}`.toLowerCase().includes(query));
  const groups = [...new Set(sources.map((source) => source.group))];
  $("#sourceList").innerHTML = groups.map((group) => `
    <div class="source-group-title">${escapeHtml(group)}</div>
    ${sources.filter((source) => source.group === group).map((source) => `
      <label class="source-option">
        <input type="checkbox" value="${escapeHtml(source.id)}" ${sourceSelection.has(source.id) ? "checked" : ""}>
        <span><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(source.strategy.replaceAll("-", " "))}</small></span>
      </label>`).join("")}
  `).join("") || '<div class="empty-state"><p>No sources match that search.</p></div>';
  $$(".source-option input").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) sourceSelection.add(input.value); else sourceSelection.delete(input.value);
    renderSourceCount();
    updateSummary();
  }));
  renderSourceCount();
}

function renderSourceCount() {
  const total = appState?.sources.length || 0;
  $("#sourceCount").textContent = sourceSelection.size === total ? `All ${total} selected` : `${sourceSelection.size} of ${total} selected`;
  $("#toggleSources").textContent = sourceSelection.size ? "Clear all" : "Select all";
}

function renderCounts() {
  if (!appState) return;
  const { unprocessed, staging, ready } = appState.queues;
  $("#unprocessedCount").textContent = `${unprocessed.length} collected`;
  $("#stagingCount").textContent = `${staging.length} staged`;
  $("#readyCount").textContent = `${ready.length} prepared`;
  $("#tabUnprocessed").textContent = unprocessed.length;
  $("#tabStaging").textContent = staging.length;
  $("#tabReady").textContent = ready.length;
  $("#queueBadge").textContent = unprocessed.length + staging.length + ready.length;
}

function queueItems() {
  return appState?.queues?.[activeQueue] || [];
}

function renderQueue() {
  if (!appState) return;
  const items = queueItems();
  const validIds = new Set(items.map((item) => item.id));
  queueSelection = new Set([...queueSelection].filter((id) => validIds.has(id)));
  $("#selectedLabel").textContent = `${queueSelection.size} selected`;
  $("#selectAllQueue").checked = items.length > 0 && queueSelection.size === items.length;
  $("#stageSelected").classList.toggle("hidden", activeQueue !== "unprocessed");
  $("#deploySelected").disabled = queueSelection.size === 0 || Boolean(appState.job?.status === "running");
  $("#stageSelected").disabled = queueSelection.size === 0 || Boolean(appState.job?.status === "running");
  if (!items.length) {
    const copy = activeQueue === "unprocessed" ? ["Nothing waiting for rewrite", "Newly scraped source bundles will appear here."] : activeQueue === "staging" ? ["No rewrite drafts", "Run a collection or prepare items from the Collected tab."] : ["No interrupted publications", "Prepared items appear here only when a deploy stops before commit."];
    $("#queueTable").innerHTML = `<div class="empty-state"><span>✓</span><h3>${copy[0]}</h3><p>${copy[1]}</p></div>`;
    return;
  }
  const isSource = activeQueue === "unprocessed";
  $("#queueTable").innerHTML = `<table class="data-table"><thead><tr><th></th><th>Story</th><th>${isSource ? "Source" : "Section"}</th><th>Date</th><th>${isSource ? "Archive" : "Status"}</th><th>Links</th></tr></thead><tbody>${items.map((item) => `
    <tr>
      <td><input class="queue-check" type="checkbox" value="${escapeHtml(item.id)}" ${queueSelection.has(item.id) ? "checked" : ""}></td>
      <td class="story-cell"><strong>${escapeHtml(item.title)}</strong><small>${isSource ? `${item.words ? `${formatNumber.format(item.words)} words · ` : ""}${item.images} archived image${item.images === 1 ? "" : "s"}` : escapeHtml(item.slug)}</small></td>
      <td>${escapeHtml(isSource ? item.sourceName : item.section)}</td>
      <td>${escapeHtml(formatDate(item.published, { month: "short", day: "numeric", year: "numeric" }))}</td>
      <td><span class="tag ${escapeHtml(item.status || "")}">${isSource ? "Collected" : escapeHtml(item.status)}</span></td>
      <td>${isSource ? (item.sourceUrl ? `<a class="table-link" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noopener">Source ↗</a>` : "—") : `<a class="table-link" href="${escapeHtml(item.localUrl)}" target="_blank" rel="noopener">Local</a> · <a class="table-link" href="${escapeHtml(item.productionUrl)}" target="_blank" rel="noopener">Prod</a>`}</td>
    </tr>`).join("")}</tbody></table>`;
  $$(".queue-check").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) queueSelection.add(input.value); else queueSelection.delete(input.value);
    renderQueue();
  }));
}

function historyRange(run) {
  const start = String(run.date_range?.start_inclusive || "").slice(0, 10);
  const exclusive = String(run.date_range?.end_exclusive || "").slice(0, 10);
  const end = exclusive ? new Date(`${exclusive}T12:00:00`) : null;
  if (end) end.setDate(end.getDate() - 1);
  return { start, end: end ? localIso(end) : "" };
}

function renderHistory() {
  if (!appState) return;
  const history = appState.history;
  if (!history.length) {
    $("#historyList").innerHTML = '<div class="card empty-state"><span>◷</span><h3>No collection runs yet</h3><p>Your first scrape will be recorded here automatically.</p></div>';
    return;
  }
  $("#historyList").innerHTML = history.map((run, index) => {
    if (run.invalid) return `<article class="card history-card"><div class="history-summary"><div class="history-date"><strong>Invalid record</strong><small>Line ${run.historyLine}</small></div><div class="history-range"><strong>${escapeHtml(run.error)}</strong><small>${escapeHtml(run.raw)}</small></div></div></article>`;
    const range = historyRange(run);
    const total = run.totals || {};
    const perSource = run.per_source || [];
    return `<article class="card history-card" data-history="${index}">
      <div class="history-summary">
        <div class="history-date"><strong>${escapeHtml(formatDate(run.completed_at || run.started_at))}</strong><small>${escapeHtml(new Date(run.completed_at || run.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))} · ${Math.round((run.duration_ms || 0) / 1000)} sec</small></div>
        <div class="history-range"><strong>${escapeHtml(formatDate(range.start, { month: "short", day: "numeric" }))} – ${escapeHtml(formatDate(range.end, { month: "short", day: "numeric", year: "numeric" }))}</strong><small>${run.selected_sources?.length || 0} sites selected · limit ${run.limit_per_source ?? "—"} per site</small></div>
        <div class="metric"><span>Saved</span><strong>${formatNumber.format(total.articles_saved || 0)} articles</strong></div>
        <div class="metric"><span>Sites with results</span><strong>${formatNumber.format(total.sources_with_articles || 0)} / ${formatNumber.format(total.sources_requested || run.selected_sources?.length || 0)}</strong></div>
        <div class="metric"><span>Archive</span><strong>${Number(total.data_mib || 0).toFixed(1)} MiB</strong></div>
        <span class="chevron">⌄</span>
      </div>
      <div class="history-details">
        <div class="history-meta"><span>Run ID: ${escapeHtml(run.run_id)}</span><span>Failures: ${formatNumber.format(total.failed_sources || 0)} sites / ${formatNumber.format(total.extraction_failures || 0)} articles</span><span>Compression saved: ${Number((total.lossless_compression?.bytes_saved || 0) / 1_048_576).toFixed(2)} MiB</span></div>
        <div class="history-sites">${perSource.map((site) => `<div class="history-site ${escapeHtml(site.status)}"><span>${escapeHtml(site.source_name || site.source_id)}</span><span>${formatNumber.format(site.articles_saved || 0)} · ${escapeHtml(site.status)}</span></div>`).join("")}</div>
      </div>
    </article>`;
  }).join("");
  $$(".history-summary").forEach((summary) => summary.addEventListener("click", () => summary.parentElement.classList.toggle("open")));
}

function renderJob() {
  const job = appState?.job;
  if (!job) return;
  const drawer = $("#jobDrawer");
  if (job.id !== lastSeenJobId || job.status === "running") drawer.classList.remove("hidden");
  lastSeenJobId = job.id;
  $("#jobType").textContent = `${job.type} job`;
  $("#jobTitle").textContent = job.status === "running" ? job.title : job.summary;
  $("#jobStatus").textContent = job.status;
  $("#jobSpinner").className = `spinner${job.status === "succeeded" ? " done" : job.status === "failed" || job.status === "cancelled" ? " failed" : ""}`;
  $("#cancelJob").classList.toggle("hidden", job.status !== "running");
  $("#jobSteps").innerHTML = (job.steps || []).map((item) => `<div class="job-step ${escapeHtml(item.status)}"><i></i><div><strong>${escapeHtml(item.name)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</div></div>`).join("") || '<div class="job-step running"><i></i><div><strong>Starting</strong></div></div>';
  $("#jobLog").textContent = (job.logs || []).map((item) => item.message).join("\n");
  $("#jobLog").scrollTop = $("#jobLog").scrollHeight;
}

function renderLinks() {
  const links = appState?.links || [];
  if (!links.length) return;
  const key = links.map((item) => `${item.id}:${item.status}:${item.productionLive}`).join("|");
  if (key !== lastOpenedLinksKey) {
    $("#linksDrawer").classList.remove("hidden");
    lastOpenedLinksKey = key;
  }
  const live = links.filter((item) => item.productionLive).length;
  $("#linksTitle").textContent = live === links.length ? `${links.length} article${links.length === 1 ? " is" : "s are"} live` : `${links.length} article link${links.length === 1 ? "" : "s"}`;
  $("#linksList").innerHTML = links.map((item) => `<article class="article-link-card"><div><h3>${escapeHtml(item.title)}</h3><span class="live-pill ${item.productionLive ? "live" : ""}">${item.productionLive ? "Live & verified" : escapeHtml(item.status || "Staged")}</span></div><div class="link-pair"><a href="${escapeHtml(item.localUrl)}" target="_blank" rel="noopener"><span>▶ Local preview</span><b>↗</b></a><a href="${escapeHtml(item.productionUrl)}" target="_blank" rel="noopener"><span>◎ Production</span><b>↗</b></a></div></article>`).join("");
}

function renderState() {
  $("#apiDot").className = "status-dot";
  $("#apiStatus").textContent = appState.job?.status === "running" ? "Job in progress" : "Console ready";
  $("#previewDot").className = `status-dot ${appState.local.running ? "" : "muted"}`;
  $("#previewStatus").textContent = appState.local.running ? "Local preview running" : "Local preview stopped";
  $("#localBtn strong").textContent = appState.local.running ? "Open local site" : "Launch preview";
  if (!sourceInitialized) {
    sourceSelection = new Set(appState.sources.map((source) => source.id));
    sourceInitialized = true;
    renderSources();
  }
  renderCounts();
  const queueKey = `${activeQueue}:${appState.job?.status === "running"}:${queueItems().map((item) => `${item.id}:${item.status || ""}`).join("|")}`;
  if (queueKey !== lastQueueKey) {
    renderQueue();
    lastQueueKey = queueKey;
  }
  const historyKey = appState.history.map((run) => `${run.run_id || run.historyLine}:${run.completed_at || run.invalid}`).join("|");
  if (historyKey !== lastHistoryKey) {
    renderHistory();
    lastHistoryKey = historyKey;
  }
  renderJob();
  if (appState.links?.length) renderLinks();
  updateSummary();
}

async function refresh({ quiet = true } = {}) {
  try {
    appState = await request("/api/state");
    renderState();
  } catch (error) {
    $("#apiDot").className = "status-dot warn";
    $("#apiStatus").textContent = "Console disconnected";
    if (!quiet) toast(error.message, true);
  }
}

async function launchJob(endpoint, payload, message) {
  try {
    await post(endpoint, payload);
    toast(message);
    $("#jobDrawer").classList.remove("hidden");
    await refresh();
  } catch (error) {
    toast(error.message, true);
  }
}

$("#scrapeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = $('input[name="target"]:checked').value;
  await launchJob("/api/jobs/scrape", {
    start: $("#startDate").value,
    endInclusive: $("#endDate").value,
    sourceIds: [...sourceSelection],
    limit: Number($("#limit").value),
    maxImages: Number($("#maxImages").value),
    includeImages: $("#includeImages").checked,
    strictScope: $("#strictScope").checked,
    target,
  }, target === "main" ? "Collection started; successful drafts will deploy to main." : "Collection started; drafts will stop in staging.");
});

$$(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
$$('[data-go="queue"]').forEach((button) => button.addEventListener("click", () => navigate("queue")));
$$('[data-queue-tab]').forEach((button) => button.addEventListener("click", () => {
  $$('[data-queue-tab]').forEach((item) => item.classList.toggle("active", item === button));
  activeQueue = button.dataset.queueTab;
  queueSelection.clear();
  lastQueueKey = null;
  renderQueue();
}));
$("#sourceSearch").addEventListener("input", renderSources);
$("#toggleSources").addEventListener("click", () => {
  if (sourceSelection.size) sourceSelection.clear(); else appState.sources.forEach((source) => sourceSelection.add(source.id));
  renderSources(); updateSummary();
});
$("#selectAllQueue").addEventListener("change", (event) => {
  queueSelection = event.target.checked ? new Set(queueItems().map((item) => item.id)) : new Set();
  renderQueue();
});
$$('[data-adjust]').forEach((button) => button.addEventListener("click", () => {
  const input = $(`#${button.dataset.adjust}`);
  input.value = Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + Number(button.dataset.delta)));
  updateSummary();
}));
[$("#startDate"), $("#endDate"), $("#limit"), $("#includeImages")].forEach((input) => input.addEventListener("change", updateSummary));
$$('input[name="target"]').forEach((input) => input.addEventListener("change", () => {
  const direct = input.value === "main" && input.checked;
  $("#destinationNote").classList.toggle("danger", direct);
  $("#destinationNote").innerHTML = direct ? '<span>!</span><p><strong>Automatic production deploy</strong>Selected articles will be validated, committed to main, published by GitHub Pages, and checked live.</p>' : '<span>◇</span><p><strong>Recommended default</strong>Your drafts stay private on this computer until you choose Deploy.</p>';
  $("#runBtn span").textContent = direct ? "Run & deploy" : "Run collection";
}));

$("#stageSelected").addEventListener("click", () => launchJob("/api/jobs/rewrite", { ids: [...queueSelection], target: "staging", includeImages: $("#queueImages").checked }, "Preparing selected source bundles as rewrite drafts."));
$("#deploySelected").addEventListener("click", () => {
  const endpoint = activeQueue === "unprocessed" ? "/api/jobs/rewrite" : "/api/jobs/publish";
  launchJob(endpoint, { ids: [...queueSelection], target: "main", includeImages: $("#queueImages").checked }, activeQueue === "unprocessed" ? "Selected bundles will be rewritten, deployed, and verified." : "Deploying selected articles to main.");
});
$("#localBtn").addEventListener("click", async () => {
  if (appState?.local.running) window.open(appState.local.url, "_blank", "noopener");
  else await launchJob("/api/preview/start", { includeImages: $("#includeImages").checked }, "Building and launching the local site.");
});
$("#validateBtn").addEventListener("click", () => launchJob("/api/jobs/validate", { includeImages: true }, "Full workspace check started."));
$("#cancelJob").addEventListener("click", async () => { await post("/api/job/cancel"); toast("Cancellation requested."); });
$("#closeJob").addEventListener("click", () => $("#jobDrawer").classList.add("hidden"));
$("#closeLinks").addEventListener("click", () => $("#linksDrawer").classList.add("hidden"));
$("#refreshBtn").addEventListener("click", () => refresh({ quiet: false }));
$("#historyRefresh").addEventListener("click", () => refresh({ quiet: false }));

setDefaultDates();
updateSummary();
const initialView = ["run", "queue", "history"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "run";
navigate(initialView);
await refresh({ quiet: false });
polling = setInterval(() => refresh(), 1800);
window.addEventListener("beforeunload", () => clearInterval(polling));
