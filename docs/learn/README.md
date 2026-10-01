# Learn Tessera — a guided course through the whole project

This folder teaches the whole project in plain language, from "what is a database
transaction?" up to "why does a GiST exclusion constraint deadlock under 1,000
concurrent inserts?"

The other docs in `docs/` (ARCHITECTURE, DATABASE, API…) are **reference** docs.
They assume you already know the concepts. These docs are a **course**. They
explain the concepts first and then show where each one lives in the code.

## How the course is organised

It gets deeper in layers. Stop at any layer and you still have a complete picture
at that level of detail.

| # | File | Depth | Read it when you want to… |
|---|---|---|---|
| 0 | [00-concepts-primer.md](00-concepts-primer.md) | Basics → advanced | learn every backend concept this project uses, from scratch, with everyday analogies |
| 1 | [01-level1-big-picture.md](01-level1-big-picture.md) | 🟢 Top level | explain the project to anyone in 2 minutes |
| 2 | [02-level2-how-it-works.md](02-level2-how-it-works.md) | 🟡 A little deeper | follow one booking through every service, database and message |
| 3 | [03-level3-deep-dive.md](03-level3-deep-dive.md) | 🔴 Deeper | understand every advanced pattern with the real code: outbox, saga, idempotency, exclusion constraint, UNKNOWN payments, reconciliation… |
| 4 | [04a…04g file-by-file](#file-by-file-walkthroughs) | 🔬 Line level | read any file and know what nearly every line does and why |
| 5 | [05-failure-scenarios.md](05-failure-scenarios.md) | What-ifs | answer "what happens if X crashes right here?" |
| 6 | [06-resume-and-interview.md](06-resume-and-interview.md) | Career | see why this project is worth putting on a resume, with bullet points, interview Q&A and honest limits |
| 7 | [07-glossary.md](07-glossary.md) | Lookup | look up any term in one line |

### File-by-file walkthroughs

| File | Covers |
|---|---|
| [04a-shared-package.md](04a-shared-package.md) | `packages/shared`: pool, migrations, errors, idempotency, outbox, consumer, events, failpoints, HTTP shell, admission, pricing, observability |
| [04b-inventory-engine.md](04b-inventory-engine.md) | `services/inventory-engine`: the SQL schema, reserve, confirm, release, cancel, admin, availability, ledger, expiry worker, HTTP API |
| [04c-reservation-saga.md](04c-reservation-saga.md) | `services/reservation`: booking API, saga orchestrator, clients, worker |
| [04d-payment.md](04d-payment.md) | `services/payment`: UNKNOWN state, fake provider, webhooks, refunds, resolver |
| [04e-gateway-pricing.md](04e-gateway-pricing.md) | `services/gateway` and `services/pricing` |
| [04f-discovery-notification-reconciliation.md](04f-discovery-notification-reconciliation.md) | the three "read side and safety net" services |
| [04g-lab-bench-tests-console-deploy.md](04g-lab-bench-tests-console-deploy.md) | Contention Lab, seed/e2e, tests, React console, Docker/K8s, scripts |

## Suggested reading paths

- **"I have 15 minutes"** → Level 1, then the summary table at the top of Level 3.
- **"I'm preparing for an interview"** → Level 1 → Level 2 → Level 3 → 05 → 06.
- **"I want to change the code safely"** → Primer sections 1–4 → Level 3 → the file-by-file doc for the area you are touching.
- **"I forgot what X means"** → Glossary.

## Conventions used in these docs

- `path/to/file.js:123` means "line 123 of that file", so you can jump there.
- 💡 marks the *idea* behind a piece of code. ⚠️ marks a trap the code avoids.
  🧪 marks the test or lab run that proves it.
- Code snippets are copied from the repo and trimmed (`…`) for readability. The
  repo is always the source of truth.
- Numbers (deadlocks, req/s, p99) come only from `docs/benchmarks/RESULTS.md`,
  which `npm run lab` produced on one laptop. They show how the strategies compare
  with each other, not production capacity.
