# Outbound webhooks

When an app is registered with a `webhookUrl`, the service POSTs events to it as
they happen on the paired WhatsApp number. This is how the consuming backend
(e.g. nice-agenda) learns about pairing state and inbound messages.

## Delivery & signing

- Method: `POST <app.webhookUrl>`
- Body: `JSON.stringify({ event, app, ...payload })` (one JSON object).
- Headers:
  | Header | Value |
  |--------|-------|
  | `Content-Type` | `application/json` |
  | `X-WhatsApp-Event` | the event name (`qr`, `ready`, `disconnected`, `auth_failure`, `message`) |
  | `X-WhatsApp-App` | the app name (also used by the receiver to look up the verifying token) |
  | `X-WhatsApp-Signature` | `sha256=<hex>` = `HMAC-SHA256(rawBody, appToken)` |

The receiver must verify the signature against the **per-app token**, re-stringifying
the parsed body the same way (string-key order is preserved, so bytes match).

Delivery is retried a few times on non-2xx; a 2xx response is logged as
`[pool] webhook delivered: <app> <event>`. **A 2xx only means the POST was
accepted** — it does not mean the receiver acted on it.

## Events

| Event | When | Payload (besides `event`, `app`) |
|-------|------|----------------------------------|
| `qr` | a new QR code is generated | `qr` (data URL) |
| `ready` | client authenticated & ready | — |
| `authenticated` / `auth_failure` | auth state changes | `auth_failure` carries a reason |
| `disconnected` | client disconnected | `reason` |
| `message` | an inbound message arrives | see below |

## `message` payload

Emitted from `services/whatsappService.js` (`client.on('message')`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `msg.id._serialized` |
| `from` | string | **Sender JID, resolved to a phone** (`<phone>@c.us`) when possible — see LID below |
| `lid` | string \| null | The original `<lid>@lid` id when the sender used LID addressing, else `null` |
| `rawFrom` | string | The unmodified `msg.from` (always present) |
| `to` | string | Recipient JID (the paired number) |
| `body` | string | Message text |
| `type` | string | whatsapp-web.js message type (`chat`, `image`, …) |
| `timestamp` | number | Unix seconds |
| `isFromMe` | boolean | `true` if sent by the paired account |
| `hasMedia` | boolean | |

### LID (number-privacy) resolution — why `from` is rewritten

WhatsApp's number-privacy addressing ("LID") delivers inbound messages with
`msg.from` as an opaque `<lid>@lid` id instead of the contact's
`<phone>@c.us`. Consumers that match users by phone number (e.g. nice-agenda's
appointment-confirmation reply matcher) cannot map a raw LID to a user, so the
message would be **silently dropped**.

To keep `from` phone-based for consumers, the handler resolves LID → phone before
emitting:

```js
if (typeof from === 'string' && from.endsWith('@lid')) {
  const [mapping] = await this.client.getContactLidAndPhone([from]); // wwebjs ≥ 1.34.7
  if (mapping && mapping.pn) from = mapping.pn; // '<phone>@c.us'
}
```

- Resolution is **best-effort**: on failure, `from` keeps the raw id (no
  regression) and a warning is logged (`LID->phone resolve failed`).
- The original id is always recoverable via `lid` / `rawFrom`.
- Requires `whatsapp-web.js` ≥ 1.34.7 (exposes `Client.getContactLidAndPhone`).
