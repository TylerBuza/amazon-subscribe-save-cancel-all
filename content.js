// Content script: cancels Amazon Subscribe & Save subscriptions.
//
// Primary technique (robust, adapted from L422Y's gist via kranix0's userscript,
// MIT — see README attribution):
//   1. Read subscription ids from [data-subscription-id] elements on the page.
//   2. For each id, GET /auto-deliveries/ajax/cancelSubscription?...&subscriptionId=<id>
//      which returns an HTML panel containing <form name="cancelForm">.
//      That form has the correct action URL and all hidden fields, including a
//      valid anti-CSRF token — filled in by Amazon itself.
//   3. Submit those exact form fields as a POST. No guessing params/tokens.
//
// Fallback: DOM automation (clicking) if the form flow fails.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANCEL_TIMEOUT_MS = 15000;

async function waitFor(fn, timeout = 8000, interval = 250) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = fn();
    if (result) return result;
    await sleep(interval);
  }
  return null;
}

function visible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findByText(regex, root = document) {
  const candidates = root.querySelectorAll(
    "button, a, input[type=submit], [role=button], span, div"
  );
  for (const el of candidates) {
    const text = (el.innerText || el.value || "").trim();
    if (text && text.length < 60 && regex.test(text) && visible(el)) {
      return el.closest("button, a, [role=button], input") || el;
    }
  }
  return null;
}

// NOTE: DOM-clicking fallback has been removed. The native form-fetch path is
// confirmed working, and clicking Amazon's javascript: links tripped CSP.
// Kept as a safe no-op so any stray reference can't throw.
function realClick() {
  /* intentionally disabled */
}

function originBase() {
  return location.origin; // e.g. https://www.amazon.com
}

// ---------------------------------------------------------------------------
// Kept (pinned) subscriptions — persisted so they're never cancelled
// ---------------------------------------------------------------------------

const KEEP_KEY = "snsKeptIds";
let keptSet = new Set();

async function loadKept() {
  try {
    const data = await chrome.storage.local.get(KEEP_KEY);
    keptSet = new Set(data[KEEP_KEY] || []);
  } catch (e) {
    keptSet = new Set();
  }
  return keptSet;
}

async function saveKept() {
  try {
    await chrome.storage.local.set({ [KEEP_KEY]: Array.from(keptSet) });
  } catch (e) {}
}

function isKept(id) {
  return keptSet.has(id);
}

async function toggleKept(id) {
  if (keptSet.has(id)) keptSet.delete(id);
  else keptSet.add(id);
  await saveKept();
  return keptSet.has(id);
}

// Subscriptions eligible for cancellation = all found minus kept ones.
function getCancelableIds() {
  return getSubscriptionIds().filter((id) => !keptSet.has(id));
}

// ---------------------------------------------------------------------------
// Subscription id discovery
// ---------------------------------------------------------------------------

function uniqueArr(values) {
  return Array.from(new Set(values));
}

function getSubscriptionIds() {
  // Primary for this layout: each subscription card is a element carrying a
  // data-edit-url that contains the subscriptionId (SNST0_...).
  const fromEdit = [];
  for (const el of document.querySelectorAll("[data-edit-url]")) {
    const v = el.getAttribute("data-edit-url") || "";
    const m = v.match(/SNST0_[A-Z0-9]{16,}/);
    if (m) fromEdit.push(m[0]);
  }
  if (fromEdit.length) return uniqueArr(fromEdit);

  // Older layout: [data-subscription-id].
  let ids = uniqueArr(
    Array.from(document.querySelectorAll("[data-subscription-id]"))
      .map((el) => el.getAttribute("data-subscription-id"))
      .filter(Boolean)
  );
  if (ids.length) return ids;

  // Fallback: subscriptionId= links.
  const fromLinks = uniqueArr(
    Array.from(document.querySelectorAll('a[href*="subscriptionId"]'))
      .map((a) => {
        const m = a.href.match(/subscriptionId=([^&]+)/i);
        return m ? decodeURIComponent(m[1]) : null;
      })
      .filter(Boolean)
  );
  if (fromLinks.length) return fromLinks;

  // Last resort: raw scan.
  const html = document.documentElement.innerHTML;
  return uniqueArr(html.match(/SNST0_[A-Z0-9]{16,}/g) || []);
}

// Find the card element (div[data-edit-url]) for a given id.
function editCardForId(id) {
  for (const el of document.querySelectorAll("[data-edit-url]")) {
    const v = el.getAttribute("data-edit-url") || "";
    if (v.includes(id)) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Native cancel via Amazon's own cancel form
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(
      url,
      Object.assign({ credentials: "include" }, options || {}, {
        signal: controller.signal,
      })
    );
  } finally {
    clearTimeout(id);
  }
}

// Resolve a possibly-relative form action against the page origin.
function resolveAction(raw) {
  if (!raw) return null;
  try {
    return new URL(raw, location.href).href;
  } catch (e) {
    return null;
  }
}

// Returns { ok, subscriptionId, reason?, status?, action?, snippet?, panelStatus? }
async function nativeCancel(subscriptionId) {
  try {
    const enc = encodeURIComponent(subscriptionId);
    const panelUrl =
      originBase() +
      "/auto-deliveries/ajax/cancelSubscription" +
      "?deviceType=desktop&deviceContext=web&subscriptionId=" +
      enc;

    const resp = await fetchWithTimeout(
      panelUrl,
      { headers: { "x-requested-with": "XMLHttpRequest" } },
      CANCEL_TIMEOUT_MS
    );
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return {
        ok: false,
        subscriptionId,
        panelStatus: resp.status,
        reason: "cancel panel request failed: HTTP " + resp.status,
        snippet: t.slice(0, 220),
      };
    }

    const panelHtml = await resp.text();
    // Parse WITHOUT injecting into the live page (avoids CSP / side effects).
    const doc = new DOMParser().parseFromString(panelHtml, "text/html");

    let form =
      doc.querySelector("form[name='cancelForm']") ||
      doc.querySelector("form[action*='cancel' i]") ||
      doc.querySelector("form");
    if (!form) {
      return {
        ok: false,
        subscriptionId,
        panelStatus: resp.status,
        reason: "cancelForm not found in panel",
        snippet: panelHtml.slice(0, 220),
      };
    }

    const method = (form.getAttribute("method") || "POST").toUpperCase();
    const action = resolveAction(form.getAttribute("action")) || panelUrl;

    // Collect every input/select/textarea (hidden fields incl. CSRF token).
    const body = new URLSearchParams();
    form
      .querySelectorAll("input[name], select[name], textarea[name]")
      .forEach((el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if ((type === "checkbox" || type === "radio") && !el.checked) return;
        body.append(el.getAttribute("name"), el.value != null ? el.value : "");
      });

    const submit = await fetchWithTimeout(
      action,
      {
        method,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-requested-with": "XMLHttpRequest",
        },
        body,
      },
      CANCEL_TIMEOUT_MS
    );

    const t = await submit.text().catch(() => "");
    if (!submit.ok) {
      return {
        ok: false,
        subscriptionId,
        status: submit.status,
        panelStatus: resp.status,
        action,
        reason: "cancel form submit failed: HTTP " + submit.status,
        snippet: t.slice(0, 220),
      };
    }

    return {
      ok: true,
      subscriptionId,
      status: submit.status,
      panelStatus: resp.status,
      action,
      snippet: t.slice(0, 120),
    };
  } catch (e) {
    return {
      ok: false,
      subscriptionId,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// DOM fallback (click through the UI for one card)
// ---------------------------------------------------------------------------

function findSubscriptionCards() {
  const attr = [...document.querySelectorAll("[data-subscription-id]")].filter(
    visible
  );
  if (attr.length) return attr;
  const selectors = [
    '[data-testid*="subscription-card"]',
    '[class*="subscription-card"]',
    'div[class*="sss-card"]',
  ];
  for (const sel of selectors) {
    const found = [...document.querySelectorAll(sel)].filter(visible);
    if (found.length) return found;
  }
  return [];
}

// DOM-clicking fallback removed (tripped Amazon CSP on javascript: links).
// The native form-fetch path handles everything.
async function domCancel() {
  return false;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Locate the "Your Subscriptions" section heading, then return the visible
// product cards under it (the real active subscriptions).
function findYourSubscriptionCards() {
  // Find a heading whose text is "Your Subscriptions".
  let heading = null;
  const headings = document.querySelectorAll(
    "h1,h2,h3,h4,[role=heading],span,div"
  );
  for (const h of headings) {
    const t = (h.textContent || "").trim();
    if (/^your subscriptions\b/i.test(t) && t.length < 40) {
      heading = h;
      break;
    }
  }
  if (!heading) return [];

  // The cards live in a container after the heading. Walk up to a common
  // ancestor, then collect child blocks that look like product cards
  // (have an image + a "Next delivery" or "unit every" text).
  let section = heading.parentElement;
  for (let i = 0; i < 4 && section; i++) {
    const cards = cardsInside(section);
    if (cards.length) return cards;
    section = section.parentElement;
  }
  return [];
}

function cardsInside(root) {
  const all = Array.from(root.querySelectorAll("div, li"));
  const cards = all.filter((el) => {
    if (!visible(el)) return false;
    const txt = el.textContent || "";
    const hasImg = !!el.querySelector("img");
    const looksLikeSub = /next delivery|unit every|deliver/i.test(txt);
    if (!hasImg || !looksLikeSub) return false;
    // Innermost such card only (no nested card of same kind).
    const nested = Array.from(el.querySelectorAll("div, li")).some(
      (c) =>
        c !== el &&
        c.querySelector("img") &&
        /next delivery|unit every/i.test(c.textContent || "")
    );
    return !nested;
  });
  return cards;
}

// Build an ordered mapping between subscription ids and the visible cards.
// Both the id list and the visible cards come from Amazon in the same order.
let _idCardMap = null;
function buildIdCardMap() {
  const ids = getSubscriptionIds();
  const cards = findYourSubscriptionCards();
  const map = new Map();
  const n = Math.min(ids.length, cards.length);
  for (let i = 0; i < n; i++) map.set(ids[i], cards[i]);
  _idCardMap = map;
  return map;
}

function resolveCard(id) {
  // Primary: the div[data-edit-url] carrying this id. Expand to the smallest
  // ancestor (or itself) that contains a product image, so the overlay and
  // title extraction have something to work with.
  const edit = editCardForId(id);
  if (edit) {
    if (edit.querySelector && edit.querySelector("img")) return edit;
    let el = edit;
    for (let hops = 0; el && hops < 6; hops++) {
      if (el.querySelector && el.querySelector("img")) return el;
      el = el.parentElement;
    }
    return edit; // no image found nearby; still a valid card container
  }

  // Older layout fallback.
  const anchor = document.querySelector(
    '[data-subscription-id="' + CSS.escape(id) + '"]'
  );
  if (anchor) {
    let el = anchor;
    for (let hops = 0; el && hops < 8; hops++) {
      if (el.querySelector && el.querySelector("img")) return el;
      el = el.parentElement;
    }
    return anchor;
  }
  return null;
}

// Best-effort product title for a subscription id.
function titleForId(id) {
  const card = resolveCard(id);
  if (!card) return null;

  // 1) Prefer an image's alt text (usually the full product name).
  const img = card.querySelector("img[alt]");
  let t = img ? (img.getAttribute("alt") || "").trim() : "";

  // 2) Otherwise a product link / heading.
  if (!t || t.length < 3) {
    const cand =
      card.querySelector("a[href*='/dp/'], a[href*='/gp/product/']") ||
      card.querySelector("h1,h2,h3,h4,h5,[class*='title' i]");
    t = cand ? (cand.getAttribute("title") || cand.textContent || "").trim() : "";
  }

  // 3) Fallback: first non-price line of the card text.
  if (!t || t.length < 3) {
    const lines = (card.textContent || "")
      .split("\n")
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(
        (s) =>
          s.length > 4 &&
          !/^\$|price|deliver|subscribe|purchased|next delivery|every|month|edit/i.test(
            s
          )
      );
    t = lines[0] || "";
  }

  t = t.replace(/\s+/g, " ").trim();
  if (t.length > 60) t = t.slice(0, 60) + "…";
  return t || null;
}

// Product image URL for the card (for the overlay button styling if needed).
function imageForId(id) {
  const card = resolveCard(id);
  const img = card && card.querySelector("img[src]");
  return img ? img.getAttribute("src") : null;
}

async function cancelAll(opts, sendProgress, sendItem) {
  const useDomFallback = !!(opts && opts.useDomFallback);
  await loadKept();
  // Never cancel kept (pinned) subscriptions.
  const ids = getSubscriptionIds().filter((id) => !keptSet.has(id));
  const total = ids.length;
  let cancelled = 0;
  let failed = 0;
  let viaApi = 0;
  let viaDom = 0;
  const failures = [];

  // Announce the full list up front so the popup can render rows.
  sendItem({
    phase: "list",
    total,
    items: ids.map((id) => ({
      id,
      short: id.slice(0, 18),
      title: titleForId(id),
    })),
  });

  for (let i = 0; i < total; i++) {
    const id = ids[i];
    const title = titleForId(id);
    sendItem({ phase: "start", index: i, id, title });
    sendProgress(i, total, "Cancelling " + (title || id.slice(0, 16)));

    const r = await nativeCancel(id);
    let itemOk = false;
    let via = "api";

    if (r.ok) {
      itemOk = true;
    } else if (useDomFallback) {
      const card = document.querySelector(
        '[data-subscription-id="' + CSS.escape(id) + '"]'
      );
      if (card) {
        sendItem({ phase: "start", index: i, id, title, note: "fallback click" });
        itemOk = await domCancel(card);
        via = "dom";
      }
    }

    if (itemOk) {
      cancelled++;
      via === "api" ? viaApi++ : viaDom++;
      sendItem({ phase: "done", index: i, id, ok: true, via });
    } else {
      failed++;
      const reason =
        (r.reason || "failed") +
        (r.panelStatus ? " [panel " + r.panelStatus + "]" : "") +
        (r.status ? " [submit " + r.status + "]" : "");
      failures.push(id.slice(0, 16) + ": " + reason);
      sendItem({ phase: "done", index: i, id, ok: false, reason });
    }

    sendProgress(
      i + 1,
      total,
      `Done ${cancelled} · failed ${failed}`
    );
    await sleep(600); // pace requests
  }

  sendItem({ phase: "finished", cancelled, failed, total });
  return { cancelled, failed, viaApi, viaDom, failures };
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "scan") {
    sendResponse({ count: getSubscriptionIds().length });
    return;
  }

  // Full state for the popup: every subscription with title + kept flag.
  if (msg.type === "getState") {
    loadKept().then(() => {
      decorateCards();
      const ids = getSubscriptionIds();
      sendResponse({
        items: ids.map((id) => ({
          id,
          short: id.slice(0, 18),
          title: titleForId(id),
          image: imageForId(id),
          kept: keptSet.has(id),
        })),
        total: ids.length,
        keptCount: ids.filter((id) => keptSet.has(id)).length,
      });
    });
    return true;
  }

  // Inspect: lightweight, crash-proof structure dump.
  if (msg.type === "inspect") {
    try {
      const ids = getSubscriptionIds();
      const editEls = document.querySelectorAll("[data-edit-url]");
      const out = ids.map((id) => {
        const card = resolveCard(id);
        return {
          id: id.slice(0, 14),
          title: titleForId(id),
          image: !!imageForId(id),
          cardTag: card
            ? card.tagName + "." + String(card.className || "").slice(0, 30)
            : "NOT FOUND",
        };
      });
      sendResponse({
        inspect: out,
        idSource:
          editEls.length > 0
            ? "data-edit-url (" + editEls.length + ")"
            : "raw HTML",
        editUrlCount: editEls.length,
      });
    } catch (e) {
      sendResponse({ inspect: [], error: String(e) });
    }
    return;
  }

  // Toggle keep/pin for one subscription; refresh the in-page markers.
  if (msg.type === "toggleKeep") {
    toggleKept(msg.id)
      .then((nowKept) => {
        try {
          decorateCards();
          updateBannerCounts();
        } catch (e) {}
        sendResponse({ id: msg.id, kept: nowKept });
      })
      .catch((e) => sendResponse({ id: msg.id, error: String(e) }));
    return true;
  }

  if (msg.type === "debug") {
    const ids = getSubscriptionIds();
    if (!ids.length) {
      sendResponse({ harvested: 0, note: "No subscription ids found on page." });
      return;
    }
    nativeCancel(ids[0]).then((r) => {
      sendResponse({
        harvested: ids.length,
        firstId: ids[0],
        ok: r.ok,
        panelStatus: r.panelStatus,
        status: r.status,
        action: r.action,
        reason: r.reason,
        responseSnippet: r.snippet,
      });
    });
    return true;
  }

  if (msg.type === "cancelAll") {
    const sendProgress = (current, total, detail) =>
      chrome.runtime.sendMessage({ type: "progress", current, total, detail });
    const sendItem = (payload) =>
      chrome.runtime.sendMessage(Object.assign({ type: "item" }, payload));
    cancelAll(
      { useDomFallback: !!msg.useDomFallback },
      sendProgress,
      sendItem
    ).then(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------------
// Per-card Keep / Pin toggle injected onto each subscription on the page
// ---------------------------------------------------------------------------

const KEEP_BTN_CLASS = "sns-keep-toggle";

function cardForId(id) {
  return resolveCard(id);
}

function styleKeepButton(btn, kept) {
  btn.style.border = "1px solid";
  if (kept) {
    // Pinned = safe. Clicking un-pins (does NOT cancel anything).
    btn.textContent = "★ KEPT (click to unpin)";
    btn.style.background = "linear-gradient(135deg,#2ec27e,#1f9d63)";
    btn.style.color = "#fff";
    btn.style.borderColor = "#1f9d63";
  } else {
    btn.textContent = "☆ Keep (pin)";
    btn.style.background = "linear-gradient(135deg,#ffb84d,#ff9900)";
    btn.style.color = "#3a2500";
    btn.style.borderColor = "#cc7a00";
  }
}

// Find the element to anchor the overlay to (the product image, ideally).
function overlayAnchor(card) {
  const img = card.querySelector("img");
  // Use the image's positioned parent so the badge floats above the picture.
  if (img && img.parentElement) return img.parentElement;
  return card;
}

// Inject / refresh a Keep|Cancel overlay badge above each product image.
function decorateCards() {
  buildIdCardMap(); // refresh id->card pairing each pass
  const ids = getSubscriptionIds();
  for (const id of ids) {
    const card = cardForId(id);
    if (!card) continue;

    const anchor = overlayAnchor(card);
    // Make sure the anchor can position an absolute child.
    const pos = getComputedStyle(anchor).position;
    if (pos === "static" || !pos) anchor.style.position = "relative";

    // Swallow ALL pointer/mouse events so Amazon's card link never fires.
    const swallow = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    };
    const guardEvents = (el) =>
      ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"].forEach(
        (evt) => el.addEventListener(evt, swallow, true)
      );

    // --- Keep toggle badge (top-left, row 1) ---
    let btn = anchor.querySelector(
      "." + KEEP_BTN_CLASS + '[data-sns-keep-for="' + CSS.escape(id) + '"]'
    );
    if (!btn) {
      btn = document.createElement("div");
      btn.className = KEEP_BTN_CLASS;
      btn.setAttribute("data-sns-keep-for", id);
      btn.setAttribute("role", "button");
      btn.style.cssText = [
        "position:absolute",
        "top:6px",
        "left:6px",
        "z-index:2147483000",
        "cursor:pointer",
        "font:800 10px/1 system-ui,sans-serif",
        "letter-spacing:.2px",
        "padding:5px 9px",
        "border-radius:999px",
        "box-shadow:0 2px 8px rgba(0,0,0,.35)",
        "user-select:none",
        "pointer-events:auto",
        "white-space:nowrap",
      ].join(";");
      guardEvents(btn);
      btn.addEventListener(
        "click",
        async (e) => {
          swallow(e);
          const nowKept = await toggleKept(id);
          applyKeepVisual(btn, card, nowKept);
          updateBannerCounts();
        },
        true
      );
      anchor.appendChild(btn);
    }

    // --- Instant single-cancel button (stacked below Keep, row 2) ---
    let xbtn = anchor.querySelector(
      ".sns-cancel-one" + '[data-sns-cancel-for="' + CSS.escape(id) + '"]'
    );
    if (!xbtn) {
      xbtn = document.createElement("div");
      xbtn.className = "sns-cancel-one";
      xbtn.setAttribute("data-sns-cancel-for", id);
      xbtn.setAttribute("role", "button");
      xbtn.textContent = "✕ Cancel now";
      xbtn.style.cssText = [
        "position:absolute",
        "top:34px",
        "left:6px",
        "z-index:2147483000",
        "cursor:pointer",
        "font:800 10px/1 system-ui,sans-serif",
        "letter-spacing:.2px",
        "padding:5px 9px",
        "border-radius:999px",
        "background:linear-gradient(135deg,#ff6a5c,#d13212)",
        "color:#fff",
        "border:1px solid #b12704",
        "box-shadow:0 2px 8px rgba(0,0,0,.35)",
        "user-select:none",
        "pointer-events:auto",
        "white-space:nowrap",
      ].join(";");
      guardEvents(xbtn);
      xbtn.addEventListener(
        "click",
        async (e) => {
          swallow(e);
          xbtn.textContent = "Cancelling…";
          xbtn.style.opacity = "0.7";
          const r = await nativeCancel(id);
          if (r.ok) {
            xbtn.textContent = "Cancelled ✓";
            xbtn.style.background = "linear-gradient(135deg,#2ec27e,#1f9d63)";
            setTimeout(() => location.reload(), 1200);
          } else {
            xbtn.textContent = "Failed — retry";
            xbtn.style.opacity = "1";
          }
        },
        true
      );
      anchor.appendChild(xbtn);
    }

    applyKeepVisual(btn, card, isKept(id));
    // Hide the instant-cancel button on kept items (nothing to cancel).
    xbtn.style.display = isKept(id) ? "none" : "block";
  }
}

function applyKeepVisual(btn, card, kept) {
  styleKeepButton(btn, kept);
  if (card) {
    card.style.outline = kept ? "3px solid #2ec27e" : "2px dashed #ff8a7a";
    card.style.outlineOffset = "2px";
    card.style.borderRadius = "10px";
  }
}

// ---------------------------------------------------------------------------
// Floating in-page banner (slides in from bottom-right on the S&S page)
// ---------------------------------------------------------------------------

const BANNER_ID = "sns-canceller-banner-host";
let bannerRefreshCounts = null; // set by buildBanner

function updateBannerCounts() {
  if (bannerRefreshCounts) bannerRefreshCounts();
}

function buildBanner() {
  if (document.getElementById(BANNER_ID)) return;

  const host = document.createElement("div");
  host.id = BANNER_ID;
  host.style.cssText =
    "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });

  root.innerHTML = `
    <style>
      * { box-sizing:border-box; font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
      .card {
        width: 360px;
        background: linear-gradient(160deg,#171a21,#0f1117);
        color:#e6e8ec; border:1px solid #262b36; border-radius:14px;
        box-shadow:0 14px 40px rgba(0,0,0,.5);
        overflow:hidden;
        transform: translateY(140%);
        transition: transform .45s cubic-bezier(.2,.8,.2,1);
      }
      .card.in { transform: translateY(0); }
      .top {
        display:flex;align-items:center;gap:8px;
        padding:12px 14px;background:rgba(255,153,0,.08);
        border-bottom:1px solid #262b36;
      }
      .card { cursor:pointer; }
      .card:hover { border-color:#3a4150; box-shadow:0 16px 46px rgba(0,0,0,.6); }
      .title { font-size:13px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      .hint {
        font-size:10px;color:#ffb84d;font-weight:600;
        display:flex;align-items:center;gap:4px;
        opacity:.85;
      }
      .card.expanded .hint .txt::after { content:" (less)"; }
      .x { cursor:pointer;color:#9aa0ab;font-size:16px;line-height:1;padding:2px 4px;border-radius:5px; }
      .x:hover { background:#242832;color:#fff; }
      /* buttons keep their own cursor */
      .content, .top .x { cursor:default; }
      button, .x { cursor:pointer; }
      .content { padding:12px 14px; }
      .count { font-size:13px;color:#9aa0ab;margin-bottom:10px; }
      .count b { color:#fff;font-size:15px; }
      .subs { max-height:190px; overflow-y:auto; margin-bottom:10px; }
      .subs::-webkit-scrollbar { width:6px; }
      .subs::-webkit-scrollbar-thumb { background:#2c313c;border-radius:3px; }
      .srow {
        display:flex;align-items:center;gap:8px;
        padding:7px 9px;margin-bottom:6px;
        background:#171a21;border:1px solid #262b36;border-radius:8px;
        font-size:12px;cursor:pointer;transition:border-color .12s,background .12s;
      }
      .srow:hover { border-color:#3a4150; }
      .srow img { width:26px;height:26px;object-fit:contain;border-radius:5px;background:#fff;flex:0 0 auto; }
      .srow .sname { flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9aa0ab; }
      .srow .stag { font-size:10px;padding:2px 7px;border-radius:999px;background:#242832;color:#9aa0ab;white-space:nowrap; }
      .srow.kept { border-color:rgba(46,194,126,.5);background:#12211a; }
      .srow.kept .sname { color:#e6e8ec; }
      .srow.kept .stag { background:rgba(46,194,126,.15);color:#2ec27e; }
      button {
        width:100%;padding:10px;border:none;border-radius:9px;
        font-size:13px;font-weight:700;cursor:pointer;color:#fff;
        background:linear-gradient(135deg,#ff6a5c,#d13212);
        transition:filter .15s, transform .05s;
      }
      button:hover:not(:disabled){filter:brightness(1.12);}
      button:active:not(:disabled){transform:translateY(1px);}
      button:disabled{opacity:.5;cursor:default;}
      .pbar{height:9px;background:#1e222b;border-radius:5px;overflow:hidden;border:1px solid #262b36;margin-top:10px;display:none;}
      .pbar.show{display:block;}
      .pfill{height:100%;width:0%;background:linear-gradient(90deg,#ff9900,#ffcc66);transition:width .3s;}
      .cur{display:none;align-items:center;gap:8px;margin-top:9px;font-size:12px;color:#cfd3da;}
      .cur.show{display:flex;}
      .spin{width:14px;height:14px;border:2px solid rgba(255,153,0,.25);border-top-color:#ff9900;border-radius:50%;animation:sp .7s linear infinite;flex:0 0 auto;}
      @keyframes sp{to{transform:rotate(360deg);}}
      .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .meta{display:flex;justify-content:space-between;font-size:11px;color:#9aa0ab;margin-top:5px;}
      .done{margin-top:10px;font-size:12px;display:none;}
      .done.show{display:block;}
      .done.good{color:#2ec27e;} .done.bad{color:#ff8a7a;}
      .chev{cursor:pointer;color:#9aa0ab;font-size:12px;line-height:1;padding:3px 5px;border-radius:5px;transition:transform .25s, background .15s;user-select:none;}
      .chev:hover{background:#242832;color:#fff;}
      .chev.open{transform:rotate(180deg);}
      .help{
        max-height:0;overflow:hidden;
        transition:max-height .35s ease;
        border-top:1px solid #262b36;
      }
      .help.open{max-height:520px;}
      .help-inner{padding:12px 14px 16px;font-size:12px;color:#c4c9d2;line-height:1.55;}
      .help-inner h4{margin:0 0 6px;font-size:12px;color:#fff;}
      .help-inner ol{margin:0 0 10px;padding-left:18px;}
      .help-inner li{margin-bottom:5px;}
      .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;vertical-align:middle;}
      .pill.keep{background:linear-gradient(135deg,#2ec27e,#1f9d63);color:#fff;}
      .pill.cancel{background:linear-gradient(135deg,#ffb84d,#ff9900);color:#3a2500;}
      .help-inner .note{color:#9aa0ab;font-size:11px;}
      .credit{margin-top:8px;padding-top:8px;border-top:1px solid #262b36;font-size:11px;color:#9aa0ab;}
      .credit a{color:#ffb84d;text-decoration:none;font-weight:600;}
      .credit a:hover{text-decoration:underline;}
    </style>
    <div class="card" id="card">
      <div class="top">
        <span class="title">Subscribe &amp; Save - Cancel All</span>
        <span class="hint" id="hint"><span class="txt">How it works</span> <span class="chev" id="chev">▾</span></span>
        <span class="x" id="close" title="Close">✕</span>
      </div>
      <div class="content">
        <div class="count" id="count">Scanning…</div>
        <div class="subs" id="subs"></div>
        <button id="go" disabled>Cancel all</button>
        <div class="pbar" id="pbar"><div class="pfill" id="pfill"></div></div>
        <div class="meta" id="meta" style="display:none;"><span id="mcount">0 / 0</span><span id="mpct">0%</span></div>
        <div class="cur" id="cur"><div class="spin"></div><div class="lbl" id="lbl"></div></div>
        <div class="done" id="doneMsg"></div>
      </div>
      <div class="help" id="help">
        <div class="help-inner">
          <h4>How it works</h4>
          <ol>
            <li>Finds your active Subscribe &amp; Save items.</li>
            <li>On each product image, click
              <span class="pill cancel">☆ Keep (pin)</span> to
              <b style="color:#2ec27e;">protect</b> it. Protected items show
              <span class="pill keep">★ KEPT</span> and are
              <b>never cancelled</b>. Clicking Keep does <b>not</b> cancel anything.</li>
            <li>Use <span class="pill" style="background:#d13212;color:#fff;">Cancel now</span>
              on an image to cancel just that one item.</li>
            <li>Or press <b>Cancel all</b> below to cancel everything that is <b>not</b> kept.</li>
            <li>The page refreshes automatically when done.</li>
          </ol>
          <div class="note">Cancelling is permanent. Kept (★) items stay safe. Your pins are remembered.</div>
          <div class="credit">Made by Tyler Buza ·
            <a href="https://buza.dev" target="_blank" rel="noopener">buza.dev</a>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(host);
  const $ = (id) => root.getElementById(id);
  const card = $("card");
  requestAnimationFrame(() => card.classList.add("in"));

  $("close").addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.remove("in");
    setTimeout(() => host.remove(), 450);
  });

  const help = $("help");
  const chev = $("chev");
  let pinnedOpen = false; // toggled by explicit click

  function setExpanded(open) {
    help.classList.toggle("open", open);
    chev.classList.toggle("open", open);
    card.classList.toggle("expanded", open);
  }

  // Expand on hover; collapse when leaving (unless the user clicked to pin it).
  card.addEventListener("mouseenter", () => setExpanded(true));
  card.addEventListener("mouseleave", () => {
    if (!pinnedOpen) setExpanded(false);
  });

  // Click anywhere on the card (except buttons / links / close) toggles a
  // "pinned open" state so it stays expanded after the mouse leaves.
  card.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("button") || t.closest("a") || t.classList.contains("x")) {
      return; // let interactive controls do their thing
    }
    pinnedOpen = !pinnedOpen;
    setExpanded(pinnedOpen);
  });

  function refreshCount() {
    const total = getSubscriptionIds().length;
    const cancelable = getCancelableIds().length;
    const kept = total - cancelable;
    if (!total) {
      $("count").innerHTML = "No subscriptions found on this page";
    } else if (kept) {
      $("count").innerHTML =
        `<b>${cancelable}</b> to cancel · <b>${kept}</b> kept ★`;
    } else {
      $("count").innerHTML =
        `<b>${total}</b> subscription${total === 1 ? "" : "s"} found`;
    }
    $("go").disabled = cancelable === 0;
    $("go").textContent = cancelable
      ? `Cancel ${cancelable} (keep ${kept})`
      : kept
      ? "All kept — nothing to cancel"
      : "Cancel all";
    renderSubs();
    return cancelable;
  }

  // Render the list of subscriptions with thumbnails + keep/cancel status.
  function renderSubs() {
    const subsEl = $("subs");
    if (!subsEl) return;
    const ids = getSubscriptionIds();
    subsEl.innerHTML = "";
    for (const id of ids) {
      const kept = isKept(id);
      const row = document.createElement("div");
      row.className = "srow" + (kept ? " kept" : "");
      const img = imageForId(id);
      const title = titleForId(id) || id.slice(0, 18);
      row.innerHTML =
        (img
          ? '<img src="' + img.replace(/"/g, "&quot;") + '"/>'
          : '<span style="width:26px;text-align:center;">★</span>') +
        '<span class="sname"></span>' +
        '<span class="stag"></span>';
      row.querySelector(".sname").textContent = title;
      row.querySelector(".stag").textContent = kept ? "★ kept" : "will cancel";
      row.addEventListener("click", async (e) => {
        e.stopPropagation();
        const nowKept = await toggleKept(id);
        try {
          decorateCards();
        } catch (err) {}
        refreshCount();
      });
      subsEl.appendChild(row);
    }
  }

  // Let other code (keep toggles, messages) refresh the banner.
  bannerRefreshCounts = refreshCount;

  // Wait for the list to render, then decorate + show count.
  (async () => {
    await loadKept();
    let n = 0;
    for (let i = 0; i < 20 && n === 0; i++) {
      n = getSubscriptionIds().length;
      if (n) break;
      await sleep(400);
    }
    decorateCards();
    refreshCount();
    // Re-decorate as Amazon lazy-renders / paginates — throttled so we don't
    // thrash the DOM or interfere with clicks.
    let pending = null;
    const obs = new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        try {
          decorateCards();
          refreshCount();
        } catch (e) {}
      }, 600);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  })();

  $("go").addEventListener("click", async () => {
    const n = getCancelableIds().length;
    if (!n) return;

    $("go").disabled = true;
    $("go").textContent = "Cancelling…";
    $("pbar").classList.add("show");
    $("meta").style.display = "flex";
    $("cur").classList.add("show");
    $("doneMsg").classList.remove("show", "good", "bad");

    const setBar = (done, total) => {
      const pct = total ? Math.round((done / total) * 100) : 0;
      $("pfill").style.width = pct + "%";
      $("mcount").textContent = done + " / " + total;
      $("mpct").textContent = pct + "%";
    };

    const sendProgress = (current, total, detail) => {
      setBar(current, total);
      if (detail) $("lbl").textContent = detail;
      // Also broadcast so the popup (if open) stays in sync.
      chrome.runtime.sendMessage({ type: "progress", current, total, detail });
    };
    const sendItem = (payload) =>
      chrome.runtime.sendMessage(Object.assign({ type: "item" }, payload));

    const res = await cancelAll(
      { useDomFallback: false },
      sendProgress,
      sendItem
    );

    $("cur").classList.remove("show");
    setBar(res.cancelled + res.failed, res.cancelled + res.failed);
    const dm = $("doneMsg");
    dm.classList.add("show", res.failed ? "bad" : "good");
    dm.textContent = res.failed
      ? `Done. Cancelled ${res.cancelled}, failed ${res.failed}.`
      : `Cancelled ${res.cancelled} ✓ (kept ones untouched)`;
    $("go").textContent = "Done";

    if (res.cancelled > 0) {
      // Something was cancelled — hard-reload so cancelled items disappear.
      dm.textContent += " Refreshing…";
      setTimeout(() => location.reload(), 1500);
    } else {
      // Nothing cancelled (e.g. all failed) — keep the message, just refresh UI.
      setTimeout(() => {
        decorateCards();
        refreshCount();
      }, 1200);
    }
  });
}

// Show the banner once the page is ready.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(buildBanner, 800));
} else {
  setTimeout(buildBanner, 800);
}
