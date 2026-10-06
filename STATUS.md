# PayGuard current status

As of **4 October 2026**. Local, single-operator, sandbox-only hackathon prototype. Submission packaging is prepared; nothing is published or sent to Devpost. This is the current summary; historical evidence and account details are retained locally and excluded from the release package.

## Verified

| Area | Evidence |
| --- | --- |
| PayPal OAuth | Reverified after legacy revocation at 2026-10-04T20:10:01.180Z; existing REST app authenticates with Payouts scope; no payout attempted |
| Sender/recipient | Business sandbox sender and separate Personal recipient confirmed; REST/recipient configuration unchanged after legacy revocation |
| Real payments | Two distinct USD 0.01 payouts through agent → gateway → policy → signed grant → verifying executor → PayPal → receipt/audit |
| Settlement | Both payouts independently matched against the PayPal API; batch and item `SUCCESS` |
| Real AI | Local Ollama 0.35.1, qwen2.5:1.5b, cloud disabled, loopback endpoint; second settled payout used actual model extraction |
| AI cases | 9/9 allow/review/deny/malformed/ambiguous/injection cases passed; four review/denied execution attempts returned HTTP 403 and never reached executor |
| Audit | Both journal hash chains validated; exactly two sandbox execution reservations, total USD 0.02 of mock funds |
| Tests | 22 passed, zero failures in release verification, including actual three-process HTTP/restart behavior; fixtures are separate from provider evidence |
| Syntax/UI | Syntax checks passed for 16 JavaScript files; desktop/mobile UI previously verified, UI source unchanged during provider integration and packaging |

USD 0.01 is the smallest positive amount represented by this USD policy and was accepted by PayPal in these runs; this is not a claim about a universal provider minimum. At this amount policy did not require human threshold review. An authenticated operator initiated execution; review requests above USD 50 were blocked without approval.

The requested “Pay contractor@example.com $120 for invoice INV-1042 for development work” extracted the expected six fields, then was denied because that synthetic recipient is not allowlisted. The configured-recipient USD 120 case required review. AI never made the authorization decision.

An initial ambiguous input caused the model to select one of two amounts. That proposal never executed and expired; deterministic explicit-input and term-binding checks were added, and the final nine-case run passed. Those checks cover tested syntax, not every semantic ambiguity.

## Simulated

- `PAYMENT_PROVIDER=demo`: offline receipts, no PayPal calls or funds movement.
- `AI_PROVIDER=demo`: deterministic parser, no model inference. The first real payout used this parser; its provider execution was real.
- Provider contract/unit tests use fixtures. Release screenshots show the labeled offline demo with synthetic data.

## Release preparation

Public-facing documentation, a 150-second demo script and three reviewed synthetic screenshots are prepared. Apache-2.0 is approved, with the official LICENSE, NOTICE naming Arvydas Kostinas as copyright owner, and consistent package metadata and README/asset references. The reviewed 35-file archive passes packaging and privacy checks; all 22 tests pass, and syntax checks cover 16 JavaScript files. The explicit source package excludes runtime data, model downloads, private configuration, exact provider identifiers and internal notes. Screenshot PNGs contain no text/EXIF metadata. The local historical record is preserved; it is not copied into the public package.

**Exposed legacy NVP/SOAP credential revoked.** An initial Remove attempt failed; refreshing redirected to sandbox login. After restoring the matching Business mock login privately, the signature was still present. A fresh-session Remove succeeded, and reopening the legacy section showed **Request API credentials – PayPal**, with the old signature and Remove controls absent. No replacement credential was generated or agreement accepted; the new-credential sheet was closed. Existing local REST credentials, recipient and .env bytes remained unchanged. REST OAuth/Payouts scope, the full tests and syntax checks passed afterward; the live gateway returned HTTP 200 in sandbox/Ollama mode. Both audit chains still verify and exactly two payout reservations remain: no new payment occurred.

**Source package: GO. Publication: HOLD** until explicit public-release authorization. Copyright attribution, the recommended public Git identity and credential remediation are resolved. The local Git history contains machine paths and personal author metadata: use the reviewed source snapshot with fresh history under the approved public identity rather than pushing that history. No repository was created and no commit, upload or remote operation was performed during this review.

## Limits

Trusted host/launcher/gateway; shared UID and filesystem; no OS sandbox, independent external audit checkpoint, multi-user identity, cumulative spending budget or trusted accounting source. Renamed invoices can evade exact duplication checks. Unknown provider outcomes require manual reconciliation and are never automatically retried. No production payment mode or public hosting is included.

Exact sanitized integration records and the earlier credential-output incident remain in the ignored local review/evidence files. No account credentials are needed to run the offline demo. See README.md for independent judge setup and DEMO_SCRIPT.md for recording instructions.
