---
name: Bug Report
about: Report a reproducible bug in the Diet App web platform
title: '[BUG] '
labels: bug
assignees: ''
---

> **Security vulnerability?** Do not open a public issue.
> Use [private vulnerability reporting](../../security/advisories/new) instead.

## Bug Description
A clear and concise description of what the bug is.

## Affected Area
- [ ] Web app (`apps/web`)
- [ ] API (`apps/api`)
- [ ] Background worker (meal-plan generation)
- [ ] Deterministic engine (calorie / macro / optimizer / shopping / substitution)
- [ ] AI integration (provider routing / validation)
- [ ] Other:

## Steps to Reproduce
1. 
2. 
3. 

## Expected Behavior
What you expected to happen.

## Actual Behavior
What actually happens. Include any error messages or unexpected output.

## Nutrition Correctness (if relevant)
If a calorie or macro value looks wrong, please be specific — the engine is
deterministic, so the same inputs must always produce the same numbers.
- Calculated value:
- Expected value:
- Inputs (profile targets, ingredients, quantities):

## Environment

| Field | Value |
|---|---|
| App version / commit | e.g. v0.1.0 or `abc1234` |
| Node.js version | e.g. 24.x |
| Operating System | e.g. Ubuntu 24.04 |
| Deployment method | Docker Compose / direct Node.js |
| Browser (if web UI bug) | e.g. Firefox 135, Chrome 133 |
| Reverse proxy | Traefik / nginx / none |
| AI provider (if relevant) | OpenAI / Anthropic / OpenRouter / Ollama / none |

## Logs
```
Paste relevant API or worker log fragments here (remove any secrets or API keys)
```

## Screenshots
If applicable, add screenshots to help explain the problem.

## Additional Context
Anything else that may help reproduce or diagnose the issue.
