const SNS_URL = "https://www.amazon.com/auto-deliveries/viewsubscriptions";

const openBtn = document.getElementById("openPage");
const scanBtn = document.getElementById("scan");
const cancelBtn = document.getElementById("cancelAll");
const statusEl = document.getElementById("status");

// Progress UI
const progressWrap = document.getElementById("progressWrap");
const pfill = document.getElementById("pfill");
const pcount = document.getElementById("pcount");
const ppct = document.getElementById("ppct");
const current = document.getElementById("current");
const currentLabel = document.getElementById("currentLabel");
const itemsEl = document.getElementById("items");
const summaryEl = document.getElementById("summary");

// Manage list
const manageEl = document.getElementById("manage");
const manageList = document.getElementById("manageList");
const emptyEl = document.getElementById("empty");

let activeTabId = null;
let foundCount = 0;
let stateItems = [];
let itemRows = {};

// ---------- helpers ----------
function setStatus(msg) {
  statusEl.textContent = msg || "";
  statusEl.style.display = msg ? "block" : "none";
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
  );
}

function onSnsPage(url) {
  return (
    /amazon\./.test(url || "") &&
    /(auto-deliveries|subscribe-and-save|viewsubscriptions)/i.test(url || "")
  );
}

// Robust messaging: inject the content script on demand, with a timeout.
function sendWithTimeout(message, ms) {
  return Promise.race([
    chrome.tabs.sendMessage(activeTabId, message),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("timed out")), ms)
    ),
  ]);
}
async function ensureAndSend(message, timeoutMs = 20000) {
  try {
    return await sendWithTimeout(message, timeoutMs);
  } catch (e) {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ["content.js"],
    });
    await new Promise((r) => setTimeout(r, 300));
    return await sendWithTimeout(message, timeoutMs);
  }
}

// ---------- manage list ----------
function cancelableCount() {
  return stateItems.filter((it) => !it.kept).length;
}

function renderManageList() {
  manageList.innerHTML = "";
  for (const it of stateItems) {
    const row = document.createElement("div");
    row.className = "krow" + (it.kept ? " kept" : "");
    const thumb = it.image
      ? '<img class="kthumb" src="' + escapeAttr(it.image) + '" />'
      : '<span class="kthumb ph"></span>';
    row.innerHTML =
      thumb +
      '<span class="kname"></span>' +
      '<span class="tag"></span>';
    row.querySelector(".kname").textContent =
      it.title || it.short || it.id.slice(0, 18);
    row.querySelector(".tag").textContent = it.kept ? "Keeping" : "Will cancel";
    row.title = it.kept
      ? "Click to allow this to be cancelled"
      : "Click to keep this subscription";
    row.addEventListener("click", async () => {
      try {
        const r = await ensureAndSend({ type: "toggleKeep", id: it.id });
        it.kept =
          r && typeof r.kept === "boolean" ? r.kept : !it.kept;
      } catch (e) {
        it.kept = !it.kept;
      }
      renderManageList();
      updateCancelBtn();
    });
    manageList.appendChild(row);
  }
  const has = stateItems.length > 0;
  manageEl.style.display = has ? "block" : "none";
  emptyEl.style.display = has ? "none" : "block";
}

function updateCancelBtn() {
  const n = cancelableCount();
  const kept = stateItems.length - n;
  cancelBtn.disabled = n === 0;
  cancelBtn.textContent = n
    ? kept
      ? `Cancel ${n}, keep ${kept}`
      : `Cancel all (${n})`
    : "Nothing to cancel";
  foundCount = n;
}

async function loadState() {
  const res = await ensureAndSend({ type: "getState" });
  stateItems = res.items || [];
  renderManageList();
  updateCancelBtn();
  return res;
}

// ---------- progress ----------
function shortLabel(item) {
  return item.title || item.short || (item.id ? item.id.slice(0, 18) : "item");
}
function buildItemList(items) {
  itemsEl.innerHTML = "";
  itemRows = {};
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "item pending";
    row.innerHTML = '<span class="ico">•</span><span class="name"></span>';
    row.querySelector(".name").textContent = shortLabel(it);
    itemsEl.appendChild(row);
    itemRows[it.id] = row;
  }
}
function setItemState(id, state) {
  const row = itemRows[id];
  if (!row) return;
  row.className = "item " + state;
  const ico = row.querySelector(".ico");
  if (state === "active") ico.innerHTML = '<span class="mini-spin"></span>';
  else if (state === "ok") ico.textContent = "✓";
  else if (state === "fail") ico.textContent = "✕";
  else ico.textContent = "•";
  row.scrollIntoView({ block: "nearest" });
}
function setProgress(done, total) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  pfill.style.width = pct + "%";
  pcount.textContent = done + " / " + total;
  ppct.textContent = pct + "%";
}
function showProgress() {
  manageEl.style.display = "none";
  emptyEl.style.display = "none";
  progressWrap.classList.add("show");
  summaryEl.classList.remove("show", "good", "bad");
  current.style.display = "flex";
  setProgress(0, foundCount);
}
function showSummary(res) {
  current.style.display = "none";
  summaryEl.classList.add("show", res.failed ? "bad" : "good");
  summaryEl.innerHTML =
    '<div class="big">' +
    (res.failed ? "Finished with issues" : "All done") +
    "</div><div class='sm'>Cancelled " +
    res.cancelled +
    (res.failed ? " · Failed " + res.failed : "") +
    "</div>" +
    (res.failures && res.failures.length
      ? "<div class='fails'>" +
        res.failures.slice(0, 5).map(escapeHtml).join("<br>") +
        "</div>"
      : "");
}

// ---------- actions ----------
openBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: SNS_URL });
});

scanBtn.addEventListener("click", async () => {
  setStatus("Refreshing…");
  try {
    await loadState();
    setStatus("");
  } catch (e) {
    setStatus("Couldn't read the page. Reload the Amazon tab and try again.");
  }
});

cancelBtn.addEventListener("click", async () => {
  scanBtn.disabled = true;
  cancelBtn.disabled = true;
  setStatus("");
  showProgress();
  try {
    const res = await ensureAndSend({ type: "cancelAll", useDomFallback: false });
    setProgress(res.cancelled + res.failed, res.cancelled + res.failed);
    showSummary(res);
    if (res.cancelled > 0) {
      setTimeout(() => {
        try {
          chrome.tabs.reload(activeTabId);
        } catch (e) {}
      }, 1500);
    } else {
      try {
        await loadState();
      } catch (e) {}
    }
  } catch (e) {
    setStatus("Lost connection to the page. Some items may already be cancelled.");
  }
  scanBtn.disabled = false;
});

// live updates from the page's own Cancel button
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    setProgress(msg.current, msg.total);
    if (msg.detail) currentLabel.textContent = msg.detail;
    return;
  }
  if (msg.type === "item") {
    if (msg.phase === "list") {
      foundCount = msg.total;
      showProgress();
      buildItemList(msg.items || []);
      setProgress(0, msg.total);
    } else if (msg.phase === "start") {
      currentLabel.textContent =
        "Cancelling " + (msg.title || (msg.id ? msg.id.slice(0, 18) : ""));
      setItemState(msg.id, "active");
    } else if (msg.phase === "done") {
      setItemState(msg.id, msg.ok ? "ok" : "fail");
    } else if (msg.phase === "finished") {
      current.style.display = "none";
    }
  }
});

// ---------- init ----------
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab.id;
  const url = tab.url || "";
  if (onSnsPage(url)) {
    scanBtn.disabled = false;
    openBtn.style.display = "none";
    try {
      await loadState();
      setStatus("");
    } catch (e) {
      setStatus("Click Refresh once your subscriptions have loaded.");
    }
  } else {
    setStatus("Open your Subscribe & Save page to begin.");
    emptyEl.style.display = "none";
  }
}

init();
