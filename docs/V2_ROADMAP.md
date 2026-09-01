# Josi V2 roadmap

This file tracks post-launch V2 work. Items here are deliberately separate
from the current CE launch blockers and must not delay or dilute launch fixes.

## V2.1 — Multilingual GUI and localization platform

Josi's complete user interface must support multiple languages. This is an
internationalization system, not a one-time translation pass.

Initial target languages:

- English
- Spanish
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
- English, Spanish, Hebrew and Russian cover every required web surface with no
  hard-coded English leakage.
- Hebrew passes real RTL visual and interaction tests at supported breakpoints.
- Mobile apps use the same canonical terminology and coverage rules.
- Missing or malformed translations fail CI and never render raw translation
  keys to users.

