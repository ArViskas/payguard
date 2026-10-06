# PayGuard — 150-second demo

Target: a 2 minute 30 second video showing a working app, the authorization boundary, actual AI and verified sandbox integration. Record locally; upload/publication requires separate approval. No music, sponsor logos, credential pages, personal browser chrome, account emails, local machine paths or private notifications.

## Recording preparation

Use the offline demo for the human-approved USD 120 execution; keep the simulation label visible. Use real Ollama with offline payments for fresh structured-intent demonstrations. For real sandbox settlement, show the already recorded successful USD 0.01 result and independent evidence in a separately prepared clip. Do not execute additional payouts for packaging. Never label the USD 120 simulated execution as a real payout.

Prepare only these fields from the actual local settlement record for the evidence clip: provider, amount, currency, batchStatus, itemStatus, independentApiRead, settled and observedAt. Exclude recipient, hashes, request/batch/item identifiers, OAuth data and filesystem paths. This is a filtered view of a real saved API read, not a fabricated receipt. Keep browser capture to the application area with synthetic data; do not record operator passphrase entry.

Use fresh invoice references when proposing new examples; they expire five minutes after proposal. The sandbox recipient is privately configured by the operator, never published as judge credentials.

## Timed script

| Time | Picture/action | Spoken copy |
| --- | --- | --- |
| 0–15s | App overview and authorization boundary | “Business agents can draft payments, but a plausible instruction should not be permission to spend. PayGuard gives agent builders a separate authorization boundary.” |
| 15–35s | Real Ollama, offline payment mode. Propose USD 120 to the demo recipient with a fresh invoice; show six fields | “A small local model extracts the recipient, amount, currency, category, invoice and purpose. It has no payment credentials, signing key or tools. We can use real AI while keeping this walkthrough’s payments simulated.” |
| 35–65s | Rule checks, review screen; approve stored terms and simulate execution, with authentication entry off-camera | “The gateway evaluates fixed rules. This amount exceeds fifty dollars, so a human reviews the immutable terms. Approval and execution are separate actions. The executor verifies an Ed25519 grant, expiry and policy, then reserves execution durably before calling the payment adapter.” |
| 65–85s | Propose USD 900 to an unknown synthetic recipient; show denial and blocked execution | “This request fails both the amount ceiling and recipient allowlist. Human review cannot override denial. It receives no executable authorization.” |
| 85–100s | Propose ‘USD 20 or USD 40’ with real AI mode; show refusal | “The model must not choose between explicit alternatives. Ambiguous amounts are rejected before inference, and specified payment terms are checked against the model’s output. Other business meaning still needs operator scrutiny.” |
| 100–125s | Separately recorded filtered real settlement evidence and architecture diagram | “The real integration uses PayPal sandbox OAuth and Payouts. Two one-cent sandbox payouts went through PayGuard; the second used this local model. An independent API read matched the recorded terms and confirmed both batch and item SUCCESS. Pending submission alone is not settlement.” |
| 125–140s | Audit timeline; test result summary | “Both journals verify their hash chains. Replay reservations survive restart, and uncertain results are never automatically resent. Twenty-two tests pass; four real review or denied execution checks stopped before the executor.” |
| 140–150s | README setup and local-host limitation | “Judges can run the offline app without credentials, then enable local AI and their own sandbox accounts. This is a working local prototype, with a trusted host—not production isolation.” |

## Shot list

1. Overview and three-component boundary.
2. Real AI extraction plus deterministic review checks.
3. Synthetic recipient denial and explicit ambiguity refusal.
4. Filtered independently verified sandbox settlement evidence.
5. Audit, tests and reproducible README setup.

The prepared screenshots in docs/assets/ show the offline UI only. Record the actual model and settled-provider evidence separately. The video file and public YouTube link are still pending.
