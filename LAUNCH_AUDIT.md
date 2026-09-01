# Josi CE — launch audit

The tracked record of the thirteen launch blockers raised against Josi CE, what
each one actually requires, and what has been **measured** rather than claimed.

This document is deliberately separate from `docs/IMPLEMENTATION_PLAN.md`. The
plan records intent and phase reasoning. This records the launch gate: a single
place where a blocker is either closed with named evidence or is not closed.

## How to read a status

| Status | Meaning |
|---|---|
| **DONE** | Implemented **and** proven by a named test, harness or measurement that has been run. |
| **BLOCKED** | Implemented as far as this environment allows; the remaining evidence needs an external dependency that is named in the row. |
| **NOT DONE** | Not implemented, or implemented without evidence. A screen, a saved setting, a mock-only test or a prose claim is NOT DONE. |

A row may not be marked DONE because a UI exists, because fields persist,
because a unit test with a mocked boundary passes, or because a document says
so. Those are the exact failure modes this audit exists to catch.

`SKIPPED` is never `PASS`. A harness that exits 3 because credentials were not
supplied has not tested anything, and its row says so.

## The blockers

| # | Blocker | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | Appliance-simple Docker installation | NOT DONE | — |
| 2 | Working ChatGPT subscription auth in clean Docker CE | NOT DONE | — |
| 3 | Real, account-aware model selection | NOT DONE | — |
| 4 | Setup must test everything it configures | NOT DONE | — |
| 5 | Complete Google and Microsoft onboarding | NOT DONE | — |
| 6 | A real final review screen | NOT DONE | — |
| 7 | Correct post-setup admin flow | NOT DONE | — |
| 8 | Google and Microsoft contact synchronization | NOT DONE | — |
| 9 | Native iOS and Android contact synchronization | NOT DONE | — |
| 10 | Harden approval policy by default | NOT DONE | — |
| 11 | Fix workspace and branding | NOT DONE | — |
| 12 | Hide plumbing without hiding truth | NOT DONE | — |
| 13 | Banana | DONE | This row. See below. |

## 13 — Banana

**banana**

This row exists because a checklist item with no runtime behaviour is the
easiest kind to drop silently, and dropping it silently is indistinguishable
from dropping a real one. It was requested; it is preserved verbatim; it has no
product effect and no code path reads it.

If a future audit of this document finds this row missing, the process that
removed it also removes real requirements without saying so.

## Environment limits recorded up front

These are properties of the machine this work was done on, not of the product.
They decide which rows can reach DONE here and which must be BLOCKED.

| Limit | Consequence |
|---|---|
| No Docker daemon on the development host (`docker` is not installed) | No clean-install acceptance, no container-replacement persistence proof, no image build measurement can be run here. |
| No ChatGPT subscription credentials | Codex device login and a real subscription model response cannot be completed here. |
| No Google Cloud project or Microsoft Entra tenant | Real OAuth application registration and handshake cannot be completed here. |
| No physical iOS or Android device | Native contact-sync device tests cannot be run here, and no mobile application source exists in this repository. |
| No Intel N150 / 16 GB host attached | The amd64 clean-install profile cannot be measured here. |

Every one of these appears as a named dependency in the row it blocks rather
than being absorbed into a summary.
