# First-install findings

This is the live findings list from Roman's clean Josi CE installation on the
N150 host (`gate`, Ubuntu 26.04.1 LTS, Docker Engine 29.6.1). A finding stays
open until the fix is implemented and Roman verifies it during a fresh install
or an explicitly documented equivalent retest.

## Open

### FI-001: Reject URLs and private IP addresses in `JOSI_DOMAIN`

**Observed:** `.env` contained `JOSI_DOMAIN=http://10.10.1.5`. Compose treated
the value as a public HTTPS hostname. Caddy returned cacheable `308` redirects
to HTTPS and then failed the TLS handshake. The permanent redirect remained in
the browser after the configuration was corrected.

**Required:**

- The installer and preflight must reject values containing a URL scheme,
  path, port, or private/local IP address.
- The field must say that it accepts a bare public DNS name only, for example
  `josi.example.com`.
- LAN installations must leave `JOSI_DOMAIN` empty and use plain HTTP unless
  the operator deliberately configures trusted local TLS.
- Invalid input must fail before containers start and explain how to correct
  it.
- The invalid configuration must never emit a permanent redirect that poisons
  the operator's browser.

**Acceptance:** A clean LAN install using `10.10.1.5` reaches `/health`,
`/ready`, and `/setup` over HTTP without redirecting. Scheme-qualified and
private-IP values entered as `JOSI_DOMAIN` are refused with actionable text.

### FI-002: Every launch-checklist task needs contextual instructions

**Observed:** The post-install checklist says "Copy the master key somewhere
else" but does not identify `secrets/master.key`, show how to copy or verify
it, or link to the relevant documentation. The operator must leave the product
and hunt for instructions.

**Required:**

- Every checklist task has a visible **Show me how** link.
- Each link opens the exact relevant documentation section, not the top of a
  general manual.
- The linked instructions include paths, commands, expected output,
  verification, and recovery steps.
- Returning from documentation preserves checklist progress.
- Completed checklist items retain their help links.
- The master-key item explicitly names `secrets/master.key` and links directly
  to instructions for copying and hash-verifying the backup without printing
  the secret.

**Acceptance:** Every checklist item has a valid contextual help link, all
targets exist, and an operator can complete each item using only the linked
instructions.

### FI-003: OpenAI model test sends an invalid request

**Observed:** The admin Model page shows the configured OpenAI primary model as
`not tested`. Running **Test this model** fails the basic-reply check with:
"The provider rejected the shape of the request. This is a defect in Josi
rather than in your configuration." Josi then disables assistant chat, task
extraction, calendar tools, email tools, and document search.

**Required:**

- The OpenAI verification request must use the correct request shape for the
  selected model and authentication method.
- The test must distinguish a malformed Josi request from invalid credentials,
  an unavailable model, quota exhaustion, and unsupported capabilities.
- A failed basic request must retain enough non-secret diagnostic detail for
  the operator and support documentation to identify the failing API contract.
- The first-install flow must not present the model as usable until this exact
  verification succeeds.

**Acceptance:** From a clean installation, the configured OpenAI model passes
the basic-reply test with real content, and only capabilities actually verified
for that model are enabled. The provider receives a valid request for the
selected model and authentication method.

### FI-004: Replace ambiguous setup deferral with explicit choices

**Observed:** Optional setup work can be dismissed with **Not for this
installation**. That wording sounds permanent and does not tell the operator
whether the task will return, remain incomplete, or be disabled.

**Required:**

- Replace **Not for this installation** with two explicit actions:
  **Skip once** and **Remind me later**.
- **Skip once** bypasses the item for the current setup pass only. It remains
  visibly incomplete on the admin launch checklist and can be resumed at any
  time.
- **Remind me later** keeps the item incomplete and creates a visible reminder
  rather than silently burying it.
- Neither action may imply that the feature is permanently disabled or that
  its verification passed.
- The screen must explain the consequence of each choice in plain language.

**Acceptance:** Choosing **Skip once** lets setup continue and leaves the item
open on the launch checklist. Choosing **Remind me later** does the same and
causes the operator to receive a clear follow-up reminder. Both choices can be
reversed without repeating installation.

## Verified during this run

- The source-built stack starts successfully on the N150.
- PostgreSQL, web, worker, and Caddy containers report healthy.
- The migration container exits successfully with status 0.
- `/health` returns HTTP 200 with `{"ok":true,"service":"josi-ce"}`.
- `/ready` returns HTTP 200 with `{"ready":true,"blockers":[]}` after the
  invalid `JOSI_DOMAIN` value is removed.
