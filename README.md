# l402-receipts

**Don't trust the meter, verify it.** Signed usage receipts for metered L402
APIs, such as AI inference paid per token over Lightning.

When an agent prepays a bundle of tokens, every request draws it down. With
l402-receipts the seller signs a receipt for every debit, and the buyer can
check all of it:

- **Every debit can be recomputed.** The receipt carries the usage the model
  reported (prompt, cached and completion tokens), the rates and the debit,
  and the buyer recomputes it exactly.
- **No receipt can disappear.** A bundle's receipts are a hash chain, and the
  balance of each one follows from the one before.
- **History can't be rewritten.** Once a day the seller commits to all of
  the day's receipts with one Merkle root, signed, published on Nostr and
  timestamped in Bitcoin with OpenTimestamps.
- **Receipts are private.** Only whoever holds a bundle's payment preimage
  can read its receipts. The public anchors show one count and one hash per day.

The format is specified in [SPEC.md](SPEC.md). [Lampo](https://lampo.run)
issues receipts for every bundle bought from 25 November 2026, and
[l402-bridge](https://github.com/lamporun/l402-bridge) checks the receipt of
every answer automatically.

## Verify your receipts

Use the credential you paid with, the `Authorization` value `L402 <macaroon>:<preimage>`:

```sh
npx github:lamporun/l402-receipts verify --seller https://lampo.run \
  --credential "L402 AgEEbHNhd...:9f86d081..." --nostr
```

Example output:

```
https://lampo.run, issuer 30699c50…
4 receipts: 4 debits recomputed exactly, 0 settled at an estimate
usage 18,240 prompt (12,800 cached) + 2,113 completion tokens
bundle 2,789,400 tokens, debited 7,925, 2,781,475 left
4 of 4 receipts proven in a daily anchor, 1 anchors found on Nostr
OK: every receipt checks out
```

Any problem is printed as `PROBLEM: …` and the command exits with status 1.
The credential can also come from `--credential-file` or `L402_CREDENTIAL`.

As a library:

```js
import { verifyBundle, checkChain } from "l402-receipts";

const report = await verifyBundle({ seller: "https://lampo.run", credential, checkNostr: true });
if (!report.ok) console.log(report.problems);
```

## Issue receipts as a seller

l402-receipts reads a [Lightmeter](https://github.com/lightninglabs/lightmeter)
database. The meter has to record the usage behind every debit and the
payment behind every token: that is the optional `meterd.UsageLedger`
interface of Aperture's meter, implemented by Lightmeter's sqlite store.
Both changes are in review upstream
([aperture#346](https://github.com/lightninglabs/aperture/pull/346),
[lightmeter#9](https://github.com/lightninglabs/lightmeter/pull/9)); until
they are merged, build Lightmeter from the `usage-ledger` branch of
[lamporun/lightmeter](https://github.com/lamporun/lightmeter/tree/usage-ledger),
which pulls the Aperture change from
[lamporun/aperture](https://github.com/lamporun/aperture/tree/meterd-usage-ledger).

```sh
# A dedicated key, readable only by the service user.
l402-receipts keygen --out /etc/l402-receipts/key

# The receipts service, behind your reverse proxy on the API's origin:
# /.well-known/l402-receipts.json, /receipts and /receipts/anchors/*.
l402-receipts serve --db /var/lib/lightmeter/lightmeter.db --key /etc/l402-receipts/key \
  --anchors /var/lib/l402-receipts/anchors --public-url https://example.com --since 2026-11-25 \
  --relay wss://relay.damus.io --relay wss://nos.lol

# Hourly: anchors each finished day, retries, and upgrades timestamps once
# they are in a Bitcoin block.
l402-receipts anchor --db /var/lib/lightmeter/lightmeter.db --key /etc/l402-receipts/key \
  --anchors /var/lib/l402-receipts/anchors --public-url https://example.com --since 2026-11-25 \
  --relay wss://relay.damus.io --relay wss://nos.lol
```

The service only reads the meter's database. Lampo runs it as its own user
with a systemd sandbox; the units are in
[lamporun/lampo](https://github.com/lamporun/lampo/tree/main/deploy/systemd).

## What receipts do not prove

Receipts hold the seller to the arithmetic and the history of every debit.
They cannot prove that the upstream really counted the tokens it reported.
For open-weight models (Kimi, GLM, DeepSeek) you can spot-check the
completion tokens with the model's public tokenizer.

## License

MIT
