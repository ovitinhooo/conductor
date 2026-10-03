# Product Guidelines

## Prose Style

- Write skills and docs as direct, imperative protocols ("You MUST…", "Run…").
  Be precise and unambiguous: agents follow the text literally.
- Prefer short numbered steps and explicit decision points over narrative.
- Keep README prose friendly and concise; reserve strict MUST/NEVER language for
  skill protocols and safety-relevant steps.

## Voice & Tone

- Act as a mentor: explain the "why" behind scaffolding, not only the "what".
- Be transparent about what will happen before it happens, and report outcomes
  faithfully, including failures.
- Never expose internal mechanics (helper script names, internal section numbers)
  to end users of the plugin.

## UX Principles

- **Human in the loop:** plans and specs are approved before code is written;
  verification tasks are never marked done without explicit user confirmation.
- **Structured choices:** offer single- or multiple-choice options with a
  recommended default (and reason) and always an "Other" option; avoid raw
  open-ended questions.
- **One question at a time** in plain text chat; batch only where the host
  offers a native form or modal.
- **Host-adaptive:** use rich dialogs where available and degrade gracefully to
  text menus, with zero configuration.
- **Resumable and safe:** every flow can resume after interruption, and
  destructive actions (reverts) are git-aware and confirmed.

## Engineering Principles for Skills

- Prefer deterministic helper scripts over hand-parsing state files.
- Keep every skill, agent, and manifest lint-clean and covered by tests/evals.
- Keep behavior portable: no host-specific assumptions in shared protocols.
