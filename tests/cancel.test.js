// All Amazon responses are fixtures; these tests never contact Amazon.
(async () => {
  const output = document.getElementById("results");
  const results = [];
  const realFetch = window.fetch;
  let calls = [];
  function assert(value, message) { if (!value) throw new Error(message); }
  function mock(...responses) {
    calls = [];
    window.fetch = async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (!next) throw new Error("Unexpected request");
      if (next instanceof Error) throw next;
      return {
        ok: (next.status || 200) < 400,
        status: next.status || 200,
        url: next.url || String(url),
        text: async () => next.text || "",
      };
    };
  }
  async function test(name, fn) {
    try { await fn(); results.push(`PASS ${name}`); }
    catch (error) { results.push(`FAIL ${name}: ${error.message}`); }
  }
  const form = `<form name="cancelForm" method="post" action="submitCancel">
    <input name="token" value="a&amp;b=+">
    <input name="subscriptionId" value="fixture-subscription">
    <input name="disabled" value="no" disabled>
    <input name="unchecked" type="checkbox">
    <input name="checked" type="checkbox" checked value="yes">
    <select name="reasons" multiple><option selected value="one">One</option><option selected value="two">Two</option></select>
    <button name="confirm" value="cancel">Cancel subscription</button>
  </form>`;
  const success = { text: "<div>Your subscription has been cancelled.</div>" };
  // Matches the empty-state observed in the signed-in Amazon session.
  const emptyManager = { text: '<div class="a-alert-container"><h4 class="a-alert-heading">No active subscriptions</h4><div class="a-alert-content">Subscribe again anytime to save on items you buy often.</div></div>' };
  const cancel = () => window.snsCancelSubscription("fixture-subscription");

  await test("POST includes AJAX headers, credentials, tokens and successful controls", async () => {
    mock({ text: form }, success);
    assert((await cancel()).ok, "Cancellation not confirmed");
    assert(calls.length === 2, "Wrong number of requests");
    for (const { options } of calls) {
      assert(options.headers["x-requested-with"] === "XMLHttpRequest", "Missing AJAX header");
      assert(options.credentials === "include", "Missing credentials");
    }
    const { url, options } = calls[1];
    assert(new URL(url).pathname === "/auto-deliveries/ajax/submitCancel", "Wrong relative action");
    assert(options.method === "POST", "Wrong method");
    assert(options.body.get("token") === "a&b=+", "Token corrupted");
    assert(!options.body.has("disabled") && !options.body.has("unchecked"), "Unsuccessful controls included");
    assert(options.body.get("checked") === "yes", "Missing checkbox");
    assert(options.body.getAll("reasons").join() === "one,two", "Missing select values");
    assert(options.body.get("confirm") === "cancel", "Missing submit button");
  });
  await test("GET forms send fields in the URL, never a body", async () => {
    mock({ text: form.replace('method="post"', 'method="get"') }, success);
    assert((await cancel()).ok, "GET failed");
    assert(calls[1].options.body === undefined, "GET has a body");
    assert(new URL(calls[1].url).searchParams.get("token") === "a&b=+", "GET token missing");
  });
  await test("Missing method defaults to POST", async () => {
    mock({ text: form.replace('method="post"', "") }, success);
    assert((await cancel()).ok && calls[1].options.method === "POST", "Wrong default");
  });
  await test("Sign-in redirects do not submit credentials", async () => {
    mock({ text: '<form><input id="ap_email"></form>', url: location.origin + "/ap/signin" });
    assert((await cancel()).code === "signin" && calls.length === 1, "Sign-in form submitted");
  });
  await test("Unrelated forms are never submitted", async () => {
    mock({ text: '<form action="/s"><input name="k"></form>' }, { text: '<h1>Unknown manager layout</h1>' });
    assert((await cancel()).code === "form" && calls.every(c => !c.options.method), "Search form submitted");
  });
  await test("Stale saved ID is recognized without submitting a cancellation", async () => {
    mock({ text: '<div class="a-alert-error">The page you have requested could not be displayed</div>' }, emptyManager);
    assert((await cancel()).code === "inactive", "Stale subscription not recognized");
    assert(calls.length === 2 && calls.every(c => !c.options.method), "Unexpected write request");
  });
  await test("Only an explicit empty manager allows clearing old subscriptions", async () => {
    mock(emptyManager);
    assert(await window.snsHasNoActiveSubscriptions(), "Actual Amazon empty-state not recognized");
    for (const response of [
      { text: '<h1>Unknown layout without subscription IDs</h1>' },
      { status: 503, text: emptyManager.text },
      { text: emptyManager.text + '<input id="ap_email">' },
      { text: emptyManager.text + '<div data-subscription-id="active"></div>' },
    ]) {
      mock(response);
      assert(!await window.snsHasNoActiveSubscriptions(), "Ambiguous response cleared subscriptions");
    }
  });
  await test("Panel HTTP errors explain the failure", async () => {
    mock({ status: 403 });
    const result = await cancel();
    assert(result.code === "panel" && result.reason.includes("403"), "Missing HTTP error");
  });
  await test("Submit HTTP errors never report success", async () => {
    mock({ text: form }, { status: 503 });
    assert((await cancel()).code === "submit", "Submit error ignored");
  });
  await test("HTTP 200 with an Amazon error is a failure", async () => {
    mock({ text: form }, { text: '<div class="a-alert-error">Please try again</div>' });
    assert((await cancel()).code === "rejected", "Error reported as success");
  });
  await test("HTTP 200 alone does not clear the subscription", async () => {
    mock({ text: form }, { text: form });
    assert((await cancel()).code === "unconfirmed", "Unconfirmed result reported as success");
  });
  await test("JSON success and failure responses", async () => {
    mock({ text: form }, { text: '{"success":true}' });
    assert((await cancel()).ok, "JSON success rejected");
    mock({ text: form }, { text: '{"success":false}' });
    assert((await cancel()).code === "rejected", "JSON error accepted");
  });
  await test("Sign-in after submission is not cancellation", async () => {
    mock({ text: form }, { text: '<input id="ap_password">' });
    assert((await cancel()).code === "signin", "Sign-in not detected");
  });
  await test("Different marketplace directs user to its Amazon site", async () => {
    mock();
    assert((await window.snsCancelSubscription("fixture", "https://www.amazon.ca")).code === "origin", "Cross-origin fetch attempted");
    assert(calls.length === 0, "Unexpected cross-origin request");
  });
  await test("Tokens never sent to a cross-origin form action", async () => {
    mock({ text: form.replace('action="submitCancel"', 'action="https://example.com/cancel"') });
    assert((await cancel()).code === "action" && calls.length === 1, "Cross-origin form submitted");
  });
  await test("Network errors and timeouts have actionable messages", async () => {
    mock(new TypeError("Failed to fetch"));
    assert((await cancel()).code === "network", "Network error hidden");
    mock(new DOMException("Aborted", "AbortError"));
    assert((await cancel()).code === "timeout", "Timeout hidden");
  });

  // Exercise the actual reminder UI with a synthetic storage snapshot.
  const store = {
    snsSubscriptionSnapshot: { origin: location.origin, items: [
      { id: "fixture-subscription", title: "Test subscription", nextShipAt: Date.now() + 3600000 },
      { id: "other-subscription", title: "Other subscription", nextShipAt: Date.now() + 3600000 },
    ] },
  };
  window.chrome = { storage: { local: {
    get: async () => structuredClone(store),
    set: async (data) => Object.assign(store, structuredClone(data)),
  } } };
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const loadReminder = () => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "../reminder.js";
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });
  mock({ text: '<div data-subscription-id="fixture-subscription"></div>' });
  await loadReminder();
  await wait(1400);
  const root = document.getElementById("sns-shipping-reminder-host")?.shadowRoot;
  await test("Reminder failure preserves item and offers an Amazon link", async () => {
    assert(root, "Reminder not shown");
    mock({ status: 403 });
    root.querySelector(".cancel").click();
    await wait(30);
    assert(store.snsSubscriptionSnapshot.items.length === 2, "Failed item removed");
    const error = root.querySelector(".error");
    assert(!error.hidden && error.textContent.includes("403"), "Useful error not displayed");
    assert(error.querySelector("a").pathname === "/auto-deliveries/viewsubscriptions", "Missing Amazon link");
    assert(!root.querySelector(".cancel").disabled, "Button stuck disabled");
  });
  await test("Reminder prevents duplicate submissions and removes only the confirmed item", async () => {
    mock({ text: form }, success);
    const button = root.querySelector(".cancel");
    button.click();
    button.click();
    await wait(30);
    assert(calls.length === 2, "Duplicate cancellation request");
    assert(store.snsSubscriptionSnapshot.items.length === 1 &&
      store.snsSubscriptionSnapshot.items[0].id === "other-subscription", "Wrong snapshot item removed");
    assert(root.querySelectorAll(".row").length === 1, "Cancelled row still shown");
  });
  await test("Startup removes stale reminders but preserves pending new orders", async () => {
    document.getElementById("sns-shipping-reminder-host")?.remove();
    store.snsSubscriptionSnapshot.items.push({
      id: "pending:fixture", pending: true, title: "New order",
      nextShipAt: Date.now() + 3600000,
    });
    mock(emptyManager);
    await loadReminder();
    await wait(1400);
    assert(store.snsSubscriptionSnapshot.items.length === 1 &&
      store.snsSubscriptionSnapshot.items[0].pending, "Stale item kept or pending order erased");
    const host = document.getElementById("sns-shipping-reminder-host");
    assert(host.shadowRoot.querySelector(".cancel").textContent === "Review / cancel", "Stale cancellation still offered");
    assert(calls.length === 1 && !calls[0].options.method, "Startup attempted a write request");
  });
  await test("Startup does not overwrite a concurrently refreshed snapshot", async () => {
    document.getElementById("sns-shipping-reminder-host")?.remove();
    store.snsSubscriptionSnapshot.items = [{id:"active", nextShipAt:Date.now() + 3600000}];
    const mockedFetch = window.fetch;
    mock(emptyManager);
    const responseFetch = window.fetch;
    window.fetch = async (...args) => {
      store.snsSubscriptionSnapshot.updatedAt = Date.now() + 100;
      return responseFetch(...args);
    };
    await loadReminder();
    await wait(1400);
    assert(store.snsSubscriptionSnapshot.items[0]?.id === "active", "Concurrent update overwritten");
    window.fetch = mockedFetch;
  });
  window.fetch = realFetch;
  output.textContent = results.join("\n");
  document.documentElement.dataset.result = results.some(line => line.startsWith("FAIL")) ? "failed" : "passed";
})();
