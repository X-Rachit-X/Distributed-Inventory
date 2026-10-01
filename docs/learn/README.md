# Learn Tessera — the course

This folder is the **spine** of the documentation. The full reading order, with
time estimates and the code-reading order, is on the [docs home](../README.md).
This page lists what is in the folder and where each page sits on that path.

```
 READING PATH ─────────────────────────────────────────────────────────────────────
   01 big picture → 02 one booking → [the code] → 03 patterns → 05 failures → 06 interview
 REFERENCE ────────────────────────────────────────────────────────────────────────
   00 primer · 04 file map (+04a–04g line by line) · 07 glossary · ../atlas.html (8 diagrams)
```

| # | File | Role | Use it to… |
|---|---|---|---|
| 01 | [01-level1-big-picture.md](01-level1-big-picture.md) | 🟢 path, step 1 | explain the project in 2 minutes; system map and layer diagrams |
| 02 | [02-level2-how-it-works.md](02-level2-how-it-works.md) | 🟡 path, step 2 (**the spine**) | follow one booking: sequence diagram, every table and message, saga state diagram |
| 03 | [03-level3-deep-dive.md](03-level3-deep-dive.md) | 🔴 path, step 4 | each pattern: problem → naive version → solution → real code → proof, with diagrams |
| 05 | [05-failure-scenarios.md](05-failure-scenarios.md) | path, step 6 | answer "what if X crashes right here?" |
| 06 | [06-resume-and-interview.md](06-resume-and-interview.md) | path, step 7 | resume bullets, interview Q&A, code-review notes and their fixes |
| 00 | [00-concepts-primer.md](00-concepts-primer.md) | reference | learn a concept from zero (transactions, locks, outbox, saga…) |
| 04 | [04-file-map.md](04-file-map.md) | reference | find any file in one table, then jump to its line-by-line page |
| 04a–g | [shared](04a-shared-package.md) · [inventory](04b-inventory-engine.md) · [reservation](04c-reservation-saga.md) · [payment](04d-payment.md) · [gateway & pricing](04e-gateway-pricing.md) · [discovery, notification, reconciliation](04f-discovery-notification-reconciliation.md) · [lab, tests, console, deploy](04g-lab-bench-tests-console-deploy.md) | reference | read a file and know what nearly every line does |
| 07 | [07-glossary.md](07-glossary.md) | reference | look up a term in one line |

## How to stay connected while reading

- **Keep the booking in mind.** Every pattern in 03 exists to protect one step of
  the booking in 02. The summary table at the top of 03 says which step.
- **One idea underneath everything:** the exclusion constraint decides who gets a
  seat. When something seems complicated, ask "does this protect correctness, or
  just speed?" The layer diagram in 01 answers it.
- **Jump, don't re-read.** Every page starts with a breadcrumb back to this path.

## Conventions

- `path/to/file.js:123` means "line 123 of that file".
- 💡 the idea behind a piece of code · ⚠️ a trap the code avoids · 🧪 the test or lab
  run that proves it.
- Code snippets are copied from the repo and trimmed (`…`). The repo is the source
  of truth.
- Numbers (deadlocks, req/s, p99) come only from `docs/benchmarks/RESULTS.md`,
  produced by `npm run lab` on one laptop. They show how strategies compare, not
  production capacity.
