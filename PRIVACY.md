# Privacy policy

**Amazon Subscribe & Save: Cancel All & Reminders**  
Developer: Tyler Buza · [buza.dev](https://buza.dev)  
Last updated: November 15, 2026

## What the extension does

The extension helps you manage your Amazon Subscribe & Save subscriptions:
keep selected items, cancel unwanted subscriptions, and see reminders based on
estimated delivery dates. It works on amazon.com, amazon.ca, and amazon.co.uk.

## Data used

On supported Amazon pages, the extension reads subscription and product details
needed for these features. These include product names and image URLs, product
identifiers (ASINs), subscription IDs, estimated delivery dates, the Amazon site
used, and purchase IDs on subscription confirmation pages. These are website
content and purchase-related information.

The extension detects Subscribe Now / Set Up Subscription clicks on supported
Amazon pages so it can associate a new subscription with its product. It also
processes your Keep, Cancel, and reminder-dismissal choices.

To cancel a subscription you choose, the extension reads Amazon's cancellation
form, including its hidden form fields and anti-CSRF token, and submits it back
to the same Amazon site. These form fields are used temporarily in memory and
are not retained in extension storage. Your browser supplies your existing
Amazon session credentials to Amazon; the extension does not ask for your
password or read browser cookies using a cookies API.

The extension does not intentionally collect your name, address, email,
password, payment-card details, or browsing history outside supported Amazon
pages. Amazon's pages and responses may contain other account information;
the extension extracts the subscription information needed for its features.

## Storage and retention

Subscription snapshots, product information, purchase IDs, Keep preferences,
pending subscription detections, and reminder-dismissal timestamps are stored
in `chrome.storage.local` in your browser profile. The extension does not use
Chrome Sync to transmit this data. Dismissal lasts for 24 hours; its stored
timestamp can remain afterward. Saved details remain until updated, removed
by the extension, or deleted by you. New pending orders may remain saved until
they are matched to an active subscription.

Uninstalling the extension removes its local extension storage. Disabling it
stops its operation but does not delete saved settings. Removing the extension
does not cancel your Amazon subscriptions.

## Network requests and sharing

Subscription information and cancellation requests are exchanged directly
between your browser and Amazon over HTTPS. Product images may be loaded from
the Amazon image URLs displayed on the page. Amazon receives the ordinary
network information associated with these requests and handles it under its
own privacy policy.

The extension has no developer-operated server, analytics service, advertising,
or telemetry. Tyler Buza does not receive your subscription data through the
extension. Data is not sold, used for advertising, or transferred to data
brokers. If you voluntarily send a support report, include only the information
you want to share; public GitHub issues are visible to others.

## Permissions

- **Storage:** remembers subscription details, Keep choices, and reminders locally.
- **Scripting:** restores the packaged management script on supported Amazon
  subscription pages when you open or use the extension menu.
- **Access to supported Amazon sites:** displays the management controls and
  reminders, detects new subscriptions, and reads/submits Amazon's subscription
  forms using your signed-in session.

All executable extension code is included in the installed package. Amazon HTML
is read as data; the extension does not execute downloaded scripts.

## Limited Use

The extension's use and transfer of information received from Google APIs adheres
to the Chrome Web Store User Data Policy, including the Limited Use requirements.
User data is used only to provide the subscription-management features described
above. It is not used for unrelated profiling, advertising, or credit decisions.

## Contact

Questions about privacy: [tyler@buza.dev](mailto:tyler@buza.dev).

This extension is independent of Amazon and is not affiliated with or endorsed
by Amazon.
