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
