# L402 usage receipts, version 1

A buyer of a metered L402 API prepays a bundle of tokens, then spends it
request by request. Without receipts, the buyer has to trust the seller's
meter: it sees its balance go down, but not why. This document specifies
receipts that remove that trust:

- each debit of a bundle gets a **receipt**, signed by the seller, that the
  buyer can **recompute**: the usage the upstream reported, the rates, the
  debit, the balance left;
- a bundle's receipts form a **hash chain**, so none can be dropped,
  reordered or rewritten without breaking every receipt after it;
- once a day the seller publishes an **anchor**, a Merkle root over all the
  receipts of that day, as a Nostr note and in a Bitcoin timestamp
  (OpenTimestamps), so past receipts cannot be changed for anyone;
- receipts are **private**: only whoever holds the payment preimage of a
  bundle can read its receipts. Anchors reveal one count and one hash per day.

Receipts make the seller accountable for the arithmetic and the history of
every debit. They cannot prove that the upstream really counted the tokens
it reported; for open-weight models a buyer can spot-check those counts with
the model's public tokenizer.

## 1. Discovery

A seller that issues receipts serves `/.well-known/l402-receipts.json` on the
origin of its API:

```json
{
  "v": 1,
  "issuer": "30699c5071a8dc6b6e01e3b96d98ad8563b44b418aa85bf06dab3160baa31d50",
  "seller": "lampo.run",
  "receipts": "https://lampo.run/receipts",
  "anchors": "https://lampo.run/receipts/anchors/",
  "relays": ["wss://relay.damus.io"],
  "since": "2026-11-25"
}
```

`issuer` is the x-only secp256k1 public key (hex) that signs receipts and
anchors, a valid Nostr public key. `receipts` and `anchors` MUST be on the
same origin. `since` is the first UTC day with receipts; bundles with debits
from before that day have none. A client SHOULD pin the first issuer it sees
for a seller and treat a change as a problem to report.

## 2. Receipts

A receipt is a JSON object:

| field          | type              | meaning |
|----------------|-------------------|---------|
| `v`            | 1                 | version |
| `issuer`       | hex32             | the signing key |
| `token`        | hex32             | the metered token id: the L402 token id, or for an MPP charge the payment hash |
| `payment_hash` | hex32             | the Lightning payment that funded the bundle |
| `seq`          | integer ≥ 1       | position of this debit in the bundle's history |
| `event`        | integer           | the seller's ledger id, increasing across all bundles |
| `time`         | integer           | unix seconds |
| `model`        | string            | the model the bundle was booked for |
| `price_sats`   | integer           | what the bundle cost |
| `source`       | string            | how the debit was determined, see below |
| `usage`        | object or null    | the usage behind the debit |
| `rates`        | object or null    | the rates a weighted debit used |
| `debit`        | integer           | bundle tokens debited |
| `remaining`    | integer           | the bundle balance after this debit |
| `prev`         | hex32             | the `id` of receipt `seq - 1`, or 64 zeros for `seq` 1 |
| `id`           | hex32             | SHA-256 of the canonical JSON of all fields above |
| `sig`          | hex64             | BIP-340 Schnorr signature of `id` by `issuer` |

The canonical JSON is the JSON Canonicalization Scheme (RFC 8785); receipts
only contain strings, safe integers and null, so it is plain JSON with keys
sorted and no whitespace.

`source` is one of:

- `split`: the response's usage object had the prompt/completion split.
  `usage` is `{"prompt", "cached", "completion"}`, where `cached` is the part
  of `prompt` served from the upstream's prompt cache. When `rates` is set the
  debit is weighted:

  ```
  value = (prompt - cached) × input × 1000
        + cached × input × cached_input_permille
        + completion × output × 1000
  debit = ceil(2 × value / ((input + output) × 1000))
  ```

  with `input` and `output` the `rates` in msat per thousand tokens. This is
  the usage's value in bundle tokens priced at the blended (input + output) / 2
  rate, as Aperture's meter computes it. When `rates` is null,
  `debit = prompt + completion`.
- `total`: only a total was reported; `usage` is `{"total"}` and
  `debit = total`.
- `estimate`: no usage object was found (for example a stream the client
  abandoned) and the meter settled at its estimate. `usage` and `rates` are
  null, and the debit cannot be recomputed.
- `plain`: a debit recorded without a usage record.

## 3. Fetching receipts

```
GET <receipts>?after=<seq>
Authorization: L402 <macaroon>:<preimage>        (or LSAT, or an MPP "Payment" credential)
```

The issuer reads the token id and payment hash from the macaroon identifier,
checks that the preimage hashes to the payment hash, and that the payment
hash is the one bound to that token when the seller first authorized a
request with it. Without the last check anyone who learned a token id could
pair it with a payment of their own. The answer:

```json
{
  "v": 1,
  "issuer": "…",
  "token": "…",
  "receipts": [ … ],
  "proofs": { "1": { "day": "2026-11-25", "anchor": "<anchor id>", "index": 0, "size": 12, "path": ["…"] } }
}
```

`receipts` are the bundle's receipts with `seq > after`, oldest first.
`proofs` holds, for every receipt whose day is already anchored, its audit
path in that day's tree.

A bundle with no debits yet, or whose payment is not bound yet, answers 404.

## 4. Anchors

Shortly after each UTC day ends the issuer builds that day's anchor:

```json
{
  "v": 1,
  "issuer": "…",
  "day": "2026-11-25",
  "count": 12,
  "root": "<merkle root>",
  "first_event": 101,
  "last_event": 140,
  "prev": "<id of the previous day's anchor, or 64 zeros>",
  "id": "<SHA-256 of the canonical JSON of the fields above>",
  "sig": "<BIP-340 signature of id>"
}
```

The tree is the RFC 6962 Merkle tree (leaf hash `SHA-256(0x00 || id)`, node
hash `SHA-256(0x01 || left || right)`, split at the largest power of two
below the size; the empty tree hashes to `SHA-256("")`) over the ids of every
receipt whose `time` falls in that day, in `event` order. Audit paths are
verified as in RFC 9162, section 2.1.3.2, with the anchor's `count` as the
tree size.

The anchor is served at `<anchors><day>.json` and listed at `<anchors>`. The
issuer SHOULD also:

- publish it as a Nostr kind 1 note by the issuer key, tagged `["x", <anchor id>]`
  and `["t", "l402receipts"]`, on the relays in the discovery document;
- timestamp the anchor id with OpenTimestamps and serve the proof at
  `<anchors><day>.ots`. Verify it with `ots verify -d <anchor id> <day>.ots`.

Anchors chain through `prev`, so a day cannot be removed or replaced either.

## 5. What a buyer checks

For the receipts of its bundle, a buyer:

1. checks each `id` and `sig` against the pinned issuer;
2. checks that `token` and `payment_hash` are its own;
3. checks that `seq` starts at 1 (or continues the last receipt it kept) and
   that each `prev` is the previous receipt's `id`;
4. checks `remaining = max(0, previous remaining - debit)`; the first receipt
   gives the bundle size as `remaining + debit`;
5. recomputes every `split` and `total` debit;
6. compares the usage of each receipt with the usage object of the answer it
   received, when it kept it;
7. for every receipt on an anchored day, checks the audit path against the
   signed anchor, and optionally that the anchor is on Nostr and in Bitcoin;
8. keeps the receipts it verified, and later checks that the seller still
   serves the same ones.

Any failure is evidence, signed by the seller, that its meter did not do what
it claims.

## 6. Reference implementation

[lamporun/l402-receipts](https://github.com/lamporun/l402-receipts) issues
receipts from a [Lightmeter](https://github.com/lightninglabs/lightmeter)
database whose store implements Aperture's `meterd.UsageLedger`, anchors
them, and verifies them. [l402-bridge](https://github.com/lamporun/l402-bridge)
checks the receipt of every answer as it pays.
