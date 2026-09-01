# Josi V2 roadmap

This file tracks post-launch V2 work. Items here are deliberately separate
from the current CE launch blockers and must not delay or dilute launch fixes.

## V2.1 — Multilingual GUI and localization platform

Josi's complete user interface must support multiple languages. This is an
internationalization system, not a one-time translation pass.

Initial target languages:

- English
- Spanish
- French
- German
- Hebrew
- Russian

Required foundation:

- Extract every user-visible string into versioned locale catalogs, including
  validation, errors, email templates, notifications, onboarding, admin UI,
  mobile UI, PWA metadata and accessibility labels.
- Let each user choose a language independently, with browser/device detection
  as a suggestion rather than an irreversible default.
- Provide an organization default and a reliable English fallback for missing
  strings.
- Support right-to-left layout correctly for Hebrew, including navigation,
  forms, icons, tables, charts, mixed-direction text and mobile screens. Do not
  fake RTL by merely right-aligning text.
- Localize dates, times, numbers, currencies, plural forms, names, addresses,
  time zones and sorting through locale-aware libraries.
- Keep data content separate from interface language. Changing the GUI language
  must not silently translate or alter user/business data.
- Provide translator context, screenshots or string descriptions, placeholder
  validation and terminology glossaries.
- Add automated checks for missing keys, unused keys, placeholder mismatch,
  accidental hard-coded strings, text expansion, truncation and RTL regressions.
- Add pseudo-locales for expansion and RTL testing before accepting a release.
- Let administrators see localization coverage and prevent a language from being
  advertised as complete when required surfaces are untranslated.
- Treat AI response language as a separate user preference from GUI language.

Acceptance:

- A user can switch languages without signing out or changing another user's
  language.
- English, Spanish, French, German, Hebrew and Russian cover every required web
  surface with no hard-coded English leakage.
- Hebrew passes real RTL visual and interaction tests at supported breakpoints.
- Mobile apps use the same canonical terminology and coverage rules.
- Missing or malformed translations fail CI and never render raw translation
  keys to users.

## V2.2 — Hiring-review worker

Add a narrowly scoped worker that reads applications, resumes, cover letters
and role requirements, then gives a hiring manager a useful evidence-based
brief. It must not behave like a keyword filter or make the hiring decision.

Required behavior:

- Summarize each candidate's relevant experience, demonstrated outcomes,
  transferable skills, career progression and practical constraints.
- Compare evidence against explicit job requirements while distinguishing
  required, preferred and trainable qualifications.
- Explain why each observation matters and cite the exact source passage.
- Identify unclear claims, gaps and contradictions as interview questions, not
  automatic grounds for rejection.
- Recognize equivalent experience and nontraditional career paths instead of
  demanding exact titles or fashionable buzzwords.
- Produce structured interview topics and follow-up questions tailored to the
  candidate and role.
- Let the employer define a role rubric before applications are reviewed. Log
  rubric changes and never silently optimize it from past hiring decisions.
- Redact or suppress protected and irrelevant personal characteristics where
  practical, including name, photo, age indicators, address and graduation year,
  before substantive review.
- Never infer race, ethnicity, religion, sex, gender, disability, health,
  pregnancy, family status, national origin or other protected characteristics.
- Never auto-reject, auto-rank, or make a final recommendation. A human reviews
  the evidence and owns every employment decision.
- Preserve candidate isolation, least-privilege access, retention/deletion
  controls, audit history and the source documents required to verify a summary.
- Provide an appeal/correction path when extracted facts or summaries are wrong.
- Display prominent limitations and require legal/compliance review before the
  feature is enabled in a jurisdiction.

Acceptance:

- Every material claim in a candidate brief links to source evidence or is
  explicitly labelled as an unanswered question.
- Removing buzzwords while preserving equivalent evidence does not reduce the
  substance of the brief.
- Protected-characteristic probes, proxy features and prompt-injected resumes
  cannot influence the rubric or output.
- The worker cannot reject, hide or permanently rank an applicant through UI,
  API, background job or client-side tampering.
- Bias, accessibility, retention, privacy and employment-law reviews are
  completed and recorded before release.

## V2.3 — Job-posting and requisition worker

Add a narrowly scoped worker that turns an approved hiring need into accurate
job listings, publishes them through employer-approved channels and maintains
one authoritative register of every live, paused, expired and closed posting.
It manages the posting lifecycle; it does not choose candidates or invent the
role.

Required behavior:

- Build a structured requisition from the employer's approved title, duties,
  location, schedule, compensation, benefits, required qualifications,
  preferred qualifications and application process.
- Draft accessible, plain-language listings from that requisition without
  inflating compensation, inventing benefits or quietly turning preferences
  into requirements.
- Flag potentially exclusionary language, missing pay-transparency information,
  unrealistic requirements and jurisdiction-specific compliance questions for
  human review.
- Require explicit approval of the canonical requisition and listing before the
  first publication. Material changes to title, duties, location, compensation,
  qualifications or legal disclosures require renewed approval.
- Publish only to job boards, career pages and social channels the employer has
  explicitly connected and authorized. Never create accounts, accept paid
  promotion, purchase listings or raise a posting budget without approval.
- Adapt formatting to each channel while preserving the approved facts and a
  traceable link to the canonical listing version.
- Maintain a central posting register containing channel, external posting ID,
  URL, version, owner, status, publication and expiry dates, cost, applicant
  destination, last verification and any errors.
- Verify that listings actually became public, detect channel rejection or
  drift, surface stale and duplicate listings, and retry only within explicit
  limits.
- Support approved edits, renewals, pauses and closures across every channel,
  with a reconciliation report when a channel cannot be updated automatically.
- Preserve a complete audit trail of drafts, approvals, publications, edits,
  spend and closures. Never claim a posting succeeded without external proof.
- Hand incoming applications to the applicant-tracking and hiring-review flow
  without making ranking, rejection or employment decisions itself.
- Enforce workspace and user isolation, least-privilege connector access,
  retention rules and per-channel rate limits.
- Treat CAPTCHA, identity verification, legal attestations and terms acceptance
  as human gates. Do not bypass them or attest on the employer's behalf.

Acceptance:

- Every public listing can be reconciled to one approved requisition and exact
  content version.
- The posting register accurately distinguishes draft, awaiting approval,
  publishing, live, failed, expired, paused and closed states.
- A failed or blocked publication never appears as live, and the employer sees
  the exact channel response and required next action.
- Closing a role produces verified closure results for every channel and an
  explicit exception list for anything requiring manual action.
- Unauthorized users cannot publish, edit, renew, spend money on or close a job
  through UI, API, background jobs or client-side tampering.
- Employment-law, accessibility, privacy, connector-security and paid-spend
  controls are reviewed and recorded before release.
