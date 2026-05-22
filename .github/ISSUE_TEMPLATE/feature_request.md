---
name: Feature Request
about: Suggest a new feature or improvement for the Diet App web platform
title: '[FEATURE] '
labels: enhancement
assignees: ''
---

> Before submitting, please review [CONTRIBUTING.md](../../CONTRIBUTING.md) for
> the project's scope and coding guidelines.

## Problem / Motivation
What problem does this solve, or what use case does it enable?

## Proposed Solution
A clear and concise description of what you want to happen.

## Alternatives Considered
Other approaches you have thought about and why you ruled them out.

## Product Principles Check
Diet App has non-negotiable principles. Confirm this feature respects them:
- [ ] Nutrition stays deterministic — calorie/macro values are computed by the
      engine from the curated ingredient database, never invented.
- [ ] AI is an assistant only — any AI output is validated and recomputed
      against the database before it reaches the user.
- [ ] Works without an AI key — the feature degrades gracefully, or is
      unaffected, when no AI provider is configured.
- [ ] Not applicable

## API Contract Impact
Does this require new or changed Zod schemas in `packages/shared`? Describe them.

## Potential Use Cases
- 
- 

## Impact on Existing Functionality
Describe whether this change might affect existing features, the data model,
or the API contract.

## Additional Context
Screenshots, mockups, or links to prior art are welcome.
