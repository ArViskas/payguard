# PayGuard

An independent authorization gateway for AI payment agents. An agent may propose a payment; it cannot authorize or execute one.

## One-minute product story

A business agent proposes paying a contractor $120 for invoice INV-1042. PayGuard validates the structured intent, checks the recipient and category, and requires a human because the amount exceeds $50. An authenticated operator reviews the exact immutable payment, approves it, then explicitly executes it. A separate executor verifies a signed, short-lived authorization before submitting a PayPal sandbox payout. A second request to an unknown recipient is denied and never reaches the executor.

## MVP

Dashboard; natural-language and structured request creation; rule-by-rule evaluations; approval queue; execution receipt with honest pending/item status; durable audit timeline and JSON export; policy and architecture views. Three sample scenarios: $120 approval, $24 allow, $900 unknown-recipient deny.

Rules: USD only, $500 maximum, $50 human-approval threshold, fixed recipient allowlist, contractor/software categories, duplicate recipient + invoice prevention, five-minute grant and review lifetime. Amounts use integer cents. Deny overrides human review. The model only extracts intent; deterministic server code makes every decision.

## Product honesty

The default payment provider is an offline simulation and the default intent provider is a deterministic parser. Both are prominently labeled. Real AI is optional local Ollama. Real payments are PayPal sandbox Payouts only. Simulation is useful for judges but is not evidence of live sandbox or model integration.

Audience: builders adding payment capabilities to business agents. Success: understand the boundary in 60 seconds and demonstrate approval plus denial in under three minutes.

## Design direction

Visual thesis: a calm ink-and-ivory operations workspace with precise typography and a mint authorization boundary. Content: operating dashboard, proposal workspace, decision inspector, receipt and chronological evidence. Interaction: quick view transitions, progressive stage highlighting, and restrained button/row feedback; reduced-motion support.

## Scope

New standalone code, synthetic identities and invoices. No commercial source or private project access. Local single-operator prototype; no production deployment, public publication, account enrollment, or competition submission in this phase.
