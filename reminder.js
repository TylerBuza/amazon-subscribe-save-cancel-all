// Lightweight Amazon-wide shipping reminder.
// Subscription details are captured automatically by content.js whenever the
// user visits Amazon's Subscribe & Save manager.

(() => {
  "use strict";

  const SNAPSHOT_KEY = "snsSubscriptionSnapshot";
  const KEEP_KEY = "snsKeptIds";
  const DISMISS_KEY = "snsReminderDismissed";
  const PENDING_KEY = "snsPendingSubscriptionDetection";
  const SOON_MS = 7 * 24 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOST_ID = "sns-shipping-reminder-host";

  // The manager has its own full interface and keeps the snapshot current.
  if (/\/auto-deliveries|\/gp\/subscribe-and-save/i.test(location.pathname)) {
    return;
  }

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function formatDate(timestamp, fallback) {
    if (!timestamp) return fallback || "soon";
    return new Date(timestamp).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  async function getData() {
    const data = await chrome.storage.local.get([
      SNAPSHOT_KEY,
      KEEP_KEY,
      DISMISS_KEY,
    ]);
    return {
      snapshot: data[SNAPSHOT_KEY] || { items: [], origin: location.origin },
      kept: new Set(data[KEEP_KEY] || []),
      dismissed: data[DISMISS_KEY] || {},
    };
  }

  async function setKept(id, kept) {
    const data = await chrome.storage.local.get([KEEP_KEY, SNAPSHOT_KEY]);
    const ids = new Set(data[KEEP_KEY] || []);
    if (kept) ids.add(id);
    else ids.delete(id);

    const snapshot = data[SNAPSHOT_KEY];
    if (snapshot && Array.isArray(snapshot.items)) {
      snapshot.items = snapshot.items.map((item) =>
        item.id === id ? Object.assign({}, item, { kept }) : item
      );
    }
    await chrome.storage.local.set({
      [KEEP_KEY]: Array.from(ids),
      ...(snapshot ? { [SNAPSHOT_KEY]: snapshot } : {}),
    });
  }

  async function removeSnapshotItem(id) {
    const data = await chrome.storage.local.get(SNAPSHOT_KEY);
    const snapshot = data[SNAPSHOT_KEY];
    if (!snapshot || !Array.isArray(snapshot.items)) return;
    snapshot.items = snapshot.items.filter((item) => item.id !== id);
    snapshot.updatedAt = Date.now();
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: snapshot });
  }

  async function fetchWithTimeout(url, options, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, Object.assign({ credentials: "include" }, options, {
        signal: controller.signal,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async function cancelSubscription(item, origin) {
    try {
      const panelUrl =
        origin +
        "/auto-deliveries/ajax/cancelSubscription" +
        "?deviceType=desktop&deviceContext=web&subscriptionId=" +
        encodeURIComponent(item.id);
      const panelResponse = await fetchWithTimeout(panelUrl, {});
      if (!panelResponse.ok) return false;

      const html = await panelResponse.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const form =
        doc.querySelector("form[name='cancelForm']") ||
        doc.querySelector("form[action*='cancel' i]") ||
        doc.querySelector("form");
      if (!form) return false;

      const body = new URLSearchParams();
      form
        .querySelectorAll("input[name], select[name], textarea[name]")
        .forEach((el) => {
          const type = (el.getAttribute("type") || "").toLowerCase();
          if ((type === "checkbox" || type === "radio") && !el.checked) return;
          body.append(el.getAttribute("name"), el.value || "");
        });

      const action = new URL(form.getAttribute("action") || panelUrl, origin).href;
      const response = await fetchWithTimeout(action, {
        method: (form.getAttribute("method") || "POST").toUpperCase(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return response.ok;
    } catch (e) {
      return false;
    }
  }

  function batchKey(items) {
    return items
      .map((item) => `${item.id}:${item.nextShipAt || 0}`)
      .sort()
      .join("|");
  }

  async function dismiss(items) {
    const data = await chrome.storage.local.get(DISMISS_KEY);
    const dismissed = data[DISMISS_KEY] || {};
    dismissed[batchKey(items)] = Date.now() + DAY_MS;
    await chrome.storage.local.set({ [DISMISS_KEY]: dismissed });
  }

  function createReminder(items, snapshot) {
    if (document.getElementById(HOST_ID)) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });

    root.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:-apple-system,system-ui,"Segoe UI",sans-serif}
        .card{width:380px;background:#111318;color:#eef0f3;border:1px solid #2b3039;border-radius:15px;box-shadow:0 18px 54px rgba(0,0,0,.48);overflow:hidden;transform:translateY(130%);transition:transform .4s cubic-bezier(.2,.8,.2,1)}
        .card.in{transform:translateY(0)}
        .head{display:flex;align-items:center;padding:14px 15px;background:linear-gradient(135deg,rgba(255,153,0,.15),rgba(255,153,0,.03));border-bottom:1px solid #2b3039}
        .head strong{font-size:14px;flex:1}.head span{font-size:12px;color:#ffbd59}.close{all:unset;cursor:pointer;color:#9ba2ad;font-size:18px;padding:2px 5px;border-radius:5px}.close:hover{background:#252a32;color:#fff}
        .intro{padding:12px 15px 5px;font-size:12.5px;color:#b6bcc5;line-height:1.45}
        .items{padding:6px 12px 12px;max-height:310px;overflow:auto}
        .row{display:grid;grid-template-columns:42px 1fr;gap:10px;padding:10px;margin-bottom:8px;background:#191c22;border:1px solid #292e37;border-radius:11px}
        .row img{width:42px;height:42px;object-fit:contain;border-radius:7px;background:#fff}.ph{width:42px;height:42px;border-radius:7px;background:#282d35}
        .name{font-size:12.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.date{font-size:11px;color:#ffbd59;margin-top:3px}
        .actions{display:flex;gap:7px;margin-top:8px}.actions button{all:unset;cursor:pointer;padding:6px 10px;border-radius:8px;font-size:11px;font-weight:750;text-align:center}.keep{background:#173524;color:#45d18f;border:1px solid #286a49!important}.cancel{background:#d63b20;color:#fff}.working{opacity:.55;pointer-events:none}
        .foot{padding:0 15px 13px;font-size:10.5px;color:#858c97}
      </style>
      <div class="card" id="card">
        <div class="head"><strong>Subscribe &amp; Save shipping soon</strong><span>${items.length} item${items.length === 1 ? "" : "s"}</span><button class="close" id="close">×</button></div>
        <div class="intro">You have ${items.length} Amazon subscription${items.length === 1 ? "" : "s"} shipping within 7 days. Choose what to do before ${items.length === 1 ? "it ships" : "they ship"}.</div>
        <div class="items" id="items"></div>
        <div class="foot">Keep shipment lets this delivery continue and protects the subscription from Cancel All. Close hides this reminder for 24 hours.</div>
      </div>`;

    document.body.appendChild(host);
    const card = root.getElementById("card");
    const list = root.getElementById("items");

    const render = () => {
      list.innerHTML = "";
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML =
          (item.image
            ? `<img src="${esc(item.image)}">`
            : '<div class="ph"></div>') +
          `<div><div class="name">${esc(item.title)}</div>` +
          `<div class="date">Ships ${esc(formatDate(item.nextShipAt, item.nextDeliveryText))}</div>` +
          `<div class="actions"><button class="keep">Keep shipment</button><button class="cancel">${item.pending ? "Review / cancel" : "Cancel now"}</button></div></div>`;

        const finish = () => {
          const index = items.findIndex((x) => x.id === item.id);
          if (index !== -1) items.splice(index, 1);
          if (!items.length) {
            card.classList.remove("in");
            setTimeout(() => host.remove(), 400);
          } else render();
        };

        row.querySelector(".keep").addEventListener("click", async () => {
          row.classList.add("working");
          await setKept(item.id, true);
          finish();
        });
        row.querySelector(".cancel").addEventListener("click", async () => {
          if (item.pending) {
            location.href =
              (snapshot.origin || location.origin) +
              "/auto-deliveries/viewsubscriptions";
            return;
          }
          row.classList.add("working");
          row.querySelector(".cancel").textContent = "Cancelling…";
          const ok = await cancelSubscription(item, snapshot.origin || location.origin);
          if (ok) {
            await removeSnapshotItem(item.id);
            finish();
          } else {
            row.classList.remove("working");
            row.querySelector(".cancel").textContent = "Try again";
          }
        });
        list.appendChild(row);
      }
    };

    root.getElementById("close").addEventListener("click", async () => {
      await dismiss(items);
      card.classList.remove("in");
      setTimeout(() => host.remove(), 400);
    });
    render();
    requestAnimationFrame(() => card.classList.add("in"));
  }

  function confirmationDelivery() {
    const text = (document.body && document.body.textContent) || "";
    const match = text.match(
      /(?:estimated\s+delivery\s*)?((?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i
    );
    if (!match) return { text: null, timestamp: null };
    const now = new Date();
    const year = Number(match[4] || now.getFullYear());
    const label = `${match[2]} ${match[3]}, ${year}`;
    let date = new Date(label);
    if (Number.isNaN(date.getTime())) return { text: null, timestamp: null };
    if (!match[4] && date.getTime() < now.getTime() - DAY_MS) {
      date = new Date(`${match[2]} ${match[3]}, ${year + 1}`);
    }
    date.setHours(9, 0, 0, 0);
    return {
      text: `${match[2]} ${match[3]}`,
      timestamp: date.getTime(),
    };
  }

  function confirmationImage() {
    const images = Array.from(document.querySelectorAll("img[src]"));
    return (
      images.find((img) => {
        const src = img.src || "";
        const alt = img.alt || "";
        return (
          /m\.media-amazon\.com|images-na\.ssl-images-amazon\.com/i.test(src) &&
          !/logo|prime|smile|sprite/i.test(src + " " + alt) &&
          (img.width >= 40 || img.naturalWidth >= 40)
        );
      })?.src || null
    );
  }

  async function findConfirmedId(snapshot, pending) {
    try {
      const response = await fetch(
        location.origin + "/auto-deliveries/viewsubscriptions",
        { credentials: "include" }
      );
      if (!response.ok) return null;
      const html = await response.text();
      const ids = Array.from(new Set(html.match(/SNST0_[A-Z0-9]{16,}/g) || []));
      const known = new Set(
        (snapshot.items || []).filter((item) => !item.pending).map((item) => item.id)
      );
      const added = ids.filter((id) => !known.has(id));
      if (added.length === 1) return added[0];

      // If multiple ids are new, prefer one found near this product's ASIN.
      if (pending && pending.asin) {
        const at = html.indexOf(pending.asin);
        if (at !== -1) {
          const nearby = html
            .slice(Math.max(0, at - 3000), at + 3000)
            .match(/SNST0_[A-Z0-9]{16,}/);
          if (nearby) return nearby[0];
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  async function captureConfirmation() {
    if (!/\/gp\/buy\/thankyou\/handlers\/display\.html/i.test(location.pathname)) {
      return false;
    }
    const pageText = (document.body && document.body.textContent) || "";
    if (!/subscription confirmed|signed up for auto-deliveries|subscribe and save/i.test(pageText)) {
      return false;
    }

    const data = await chrome.storage.local.get([SNAPSHOT_KEY, PENDING_KEY, KEEP_KEY]);
    const snapshot = data[SNAPSHOT_KEY] || {
      items: [],
      origin: location.origin,
      updatedAt: 0,
    };
    const pending = data[PENDING_KEY] || {};
    const purchaseId =
      new URLSearchParams(location.search).get("purchaseId") || Date.now();
    if ((snapshot.items || []).some((item) => item.purchaseId === purchaseId)) {
      return true; // Browser refresh of a confirmation we already captured.
    }
    const delivery = confirmationDelivery();
    const title =
      pending.title ||
      document.querySelector("img[alt]")?.alt ||
      "New Amazon subscription";
    const image = pending.image || confirmationImage();

    // Amazon can take a moment to add the new subscription to the manager.
    let id = null;
    for (let attempt = 0; attempt < 3 && !id; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500));
      id = await findConfirmedId(snapshot, pending);
    }
    const provisionalId = `pending:${purchaseId}`;
    const item = {
      id: id || provisionalId,
      title,
      image,
      nextDeliveryText: delivery.text,
      nextShipAt: delivery.timestamp,
      kept: false,
      pending: !id,
      detectedAt: Date.now(),
      purchaseId,
    };

    snapshot.items = (snapshot.items || []).filter(
      (existing) =>
        existing.id !== item.id &&
        existing.id !== provisionalId &&
        !(existing.pending && existing.title === title)
    );
    snapshot.items.push(item);
    snapshot.origin = location.origin;
    snapshot.updatedAt = Date.now();
    await chrome.storage.local.set({
      [SNAPSHOT_KEY]: snapshot,
      [PENDING_KEY]: null,
    });
    showSavedToast(item);
    return true;
  }

  function showSavedToast(item) {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647;width:340px;padding:14px 15px;background:#111318;color:#eef0f3;border:1px solid #2b3039;border-radius:13px;box-shadow:0 16px 48px rgba(0,0,0,.45);font:13px system-ui,sans-serif;";
    box.innerHTML =
      `<strong>Subscription saved</strong><div style="margin-top:5px;color:#aeb4be;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(item.title)}</div>` +
      `<div style="margin-top:6px;color:#ffbd59;font-size:11px">${item.nextShipAt ? "Delivery " + esc(formatDate(item.nextShipAt, item.nextDeliveryText)) : "We'll track it when Amazon posts the delivery date."}</div>` +
      '<button style="all:unset;cursor:pointer;position:absolute;right:10px;top:8px;color:#9ba2ad;font-size:18px">×</button>';
    document.body.appendChild(box);
    box.querySelector("button").addEventListener("click", () => box.remove());
    setTimeout(() => box.remove(), 10000);
  }

  async function checkUpcoming() {
    try {
      const { snapshot, kept, dismissed } = await getData();
      const now = Date.now();
      const items = (snapshot.items || []).filter(
        (item) =>
          item.nextShipAt &&
          item.nextShipAt >= now - DAY_MS &&
          item.nextShipAt <= now + SOON_MS &&
          !kept.has(item.id)
      );
      if (!items.length) return;
      if ((dismissed[batchKey(items)] || 0) > now) return;
      createReminder(items, snapshot);
    } catch (e) {}
  }

  // Detect an explicit Subscribe Now click. Amazon only assigns the real
  // subscription id later, so prompt the user to review/sync their manager.
  function watchForSubscriptions() {
    document.addEventListener(
      "click",
      async (event) => {
        const el = event.target.closest("button, input[type=submit], a");
        if (!el) return;
        const text = (el.innerText || el.value || "").replace(/\s+/g, " ").trim();
        if (!/^subscribe now$|^set up subscription$|^subscribe & save$/i.test(text)) return;
        const title =
          (document.querySelector("#productTitle") || {}).textContent?.trim() ||
          document.title.replace(/\s*:\s*Amazon.*$/i, "");
        const image =
          document.querySelector("#landingImage, #imgBlkFront, #main-image")?.src ||
          null;
        const asin =
          document.querySelector("[data-asin]")?.getAttribute("data-asin") ||
          new URLSearchParams(location.search).get("asin") ||
          location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] ||
          null;
        await chrome.storage.local.set({
          [PENDING_KEY]: {
            title,
            image,
            asin,
            detectedAt: Date.now(),
            origin: location.origin,
          },
        });
        showDetectedToast(title);
      },
      true
    );
  }

  function showDetectedToast(title) {
    const old = document.getElementById("sns-subscribe-detected");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "sns-subscribe-detected";
    box.style.cssText =
      "position:fixed;right:20px;bottom:20px;z-index:2147483647;width:330px;padding:14px 15px;background:#111318;color:#eef0f3;border:1px solid #2b3039;border-radius:13px;box-shadow:0 16px 48px rgba(0,0,0,.45);font:13px system-ui,sans-serif;";
    box.innerHTML =
      `<strong>Subscribe &amp; Save selected</strong><div style="margin-top:5px;color:#aeb4be;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>` +
      '<div style="margin-top:10px;display:flex;gap:8px"><button data-open style="all:unset;cursor:pointer;background:#ff9900;color:#241600;padding:7px 10px;border-radius:8px;font-weight:700">Review subscriptions</button><button data-close style="all:unset;cursor:pointer;color:#aeb4be;padding:7px">Close</button></div>';
    document.body.appendChild(box);
    box.querySelector("[data-open]").addEventListener("click", () => {
      location.href = location.origin + "/auto-deliveries/viewsubscriptions";
    });
    box.querySelector("[data-close]").addEventListener("click", () => box.remove());
    setTimeout(() => box.remove(), 12000);
  }

  watchForSubscriptions();
  setTimeout(async () => {
    const captured = await captureConfirmation();
    if (!captured) await checkUpcoming();
  }, 1200);
})();
