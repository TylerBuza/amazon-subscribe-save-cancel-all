// Shared by the manager and the Amazon-wide reminder.
(() => {
  "use strict";

  const ajaxHeaders = { "x-requested-with": "XMLHttpRequest" };

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        credentials: "include",
        ...options,
        signal: controller.signal,
      });
      // Keep the timeout active while reading the response, too.
      return { response, text: await response.text() };
    } finally {
      clearTimeout(timeout);
    }
  }

  function needsSignIn(response, doc) {
    return /\/ap\/(signin|mfa|cvf)/i.test(response.url || "") ||
      !!doc.querySelector("form[name='signIn'], #ap_email, #ap_password");
  }

  // Only Amazon's explicit empty-state is authoritative. Missing IDs in an
  // error page, a sign-in page or a partially loaded layout prove nothing.
  globalThis.snsHasNoActiveSubscriptions = async (origin = location.origin) => {
    try {
      if (new URL(origin).origin !== location.origin) return false;
      const { response, text } = await request(new URL("/auto-deliveries/viewsubscriptions", origin).href);
      const doc = new DOMParser().parseFromString(text, "text/html");
      if (!response.ok || needsSignIn(response, doc)) return false;
      if (doc.querySelector("[data-edit-url*='subscriptionId'], [data-subscription-id]")) return false;
      return Array.from(doc.querySelectorAll(".a-alert-heading")).some(el =>
        /^no active subscriptions[.!]?$/i.test(el.textContent.trim()));
    } catch (_) {
      return false;
    }
  };

  globalThis.snsCancelSubscription = async (subscriptionId, origin = location.origin) => {
    const fail = (code, reason) => ({ ok: false, subscriptionId, code, reason });
    try {
      if (new URL(origin).origin !== location.origin) {
        return fail("origin", "Open this subscription's Amazon site to cancel it.");
      }
      const panelUrl = new URL("/auto-deliveries/ajax/cancelSubscription", origin);
      panelUrl.search = new URLSearchParams({
        deviceType: "desktop", deviceContext: "web", subscriptionId,
      });
      const panel = await request(panelUrl.href, { headers: ajaxHeaders });
      const doc = new DOMParser().parseFromString(panel.text, "text/html");
      if (needsSignIn(panel.response, doc)) {
        return fail("signin", "Sign in to Amazon, then try again.");
      }
      if (!panel.response.ok) {
        return fail("panel", `Amazon couldn't open cancellation (HTTP ${panel.response.status}).`);
      }
      // Never fall back to an unrelated form, such as search or sign-in.
      const form = doc.querySelector("form[name='cancelForm'], form[action*='cancel' i]");
      if (!form) {
        if (await globalThis.snsHasNoActiveSubscriptions(origin)) {
          return fail("inactive", "This subscription is no longer active on Amazon.");
        }
        return fail("form", "Amazon didn't provide a cancellation form. Open your subscriptions to refresh this item.");
      }
      const action = new URL(form.getAttribute("action") || panelUrl.href,
        panel.response.url || panelUrl.href);
      if (action.origin !== location.origin) {
        return fail("action", "Open your subscriptions on Amazon to finish cancelling.");
      }
      const method = (form.getAttribute("method") || "POST").toUpperCase();
      if (method !== "POST" && method !== "GET") {
        return fail("method", "Open your subscriptions on Amazon to finish cancelling.");
      }
      const body = new URLSearchParams();
      // FormData follows browser rules for disabled fields, checked inputs,
      // multiple selections and hidden tokens.
      const submitter = form.querySelector("button:not([type]), button[type='submit'], input[type='submit']");
      for (const [name, value] of new FormData(form, submitter || undefined)) {
        if (typeof value === "string") body.append(name, value);
      }
      const options = { method, headers: { ...ajaxHeaders } };
      if (method === "GET") {
        for (const [name, value] of body) action.searchParams.append(name, value);
      } else {
        options.headers["Content-Type"] = "application/x-www-form-urlencoded";
        options.body = body;
      }
      const submitted = await request(action.href, options);
      const resultDoc = new DOMParser().parseFromString(submitted.text, "text/html");
      if (needsSignIn(submitted.response, resultDoc)) {
        return fail("signin", "Sign in to Amazon, then check this subscription before trying again.");
      }
      if (!submitted.response.ok) {
        return fail("submit", `Amazon couldn't finish cancellation (HTTP ${submitted.response.status}). Check it on Amazon before retrying.`);
      }
      const error = resultDoc.querySelector(".a-alert-error, [role='alert'][data-error]");
      let json;
      try { json = JSON.parse(submitted.text); } catch (_) {}
      if (error || json?.success === false || json?.error || json?.status === "error") {
        return fail("rejected", "Amazon couldn't complete cancellation. Open your subscriptions to check this item.");
      }
      // A successful HTTP request alone does not mean the subscription ended.
      const resultText = resultDoc.body.textContent.replace(/\s+/g, " ");
      const confirmed = json?.success === true || json?.status === "success" ||
        /(?:subscription|auto-deliver(?:y|ies))\s+(?:(?:has|have)\s+been\s+|is\s+|was\s+)?(?:successfully\s+)?cancelled\b|(?:subscription|auto-deliver(?:y|ies))\s+(?:(?:has|have)\s+been\s+|is\s+|was\s+)?(?:successfully\s+)?canceled\b|successfully\s+cancel(?:led|ed)\s+(?:your\s+|the\s+)?subscription\b/i.test(resultText);
      if (!confirmed) {
        return fail("unconfirmed", "Amazon hasn't confirmed cancellation. Check your subscriptions before trying again.");
      }
      return { ok: true, subscriptionId, status: submitted.response.status };
    } catch (error) {
      return fail(error.name === "AbortError" ? "timeout" : "network",
        error.name === "AbortError"
          ? "Amazon took too long to respond. Check your subscriptions before trying again."
          : "Couldn't reach Amazon. Check your subscriptions before trying again.");
    }
  };
})();
