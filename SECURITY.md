# Security

This file states what the code does, with the file and the test that show it. It makes no claim beyond that.
More operational detail (App Check, revocation, launch checklist) is in [`docs/security-and-launch.md`](docs/security-and-launch.md).

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on this
repository (Security tab, "Report a vulnerability") if it is enabled, or contact the maintainers privately.
Include the affected route or file, steps to reproduce, and the impact you observed.

## Threat model (short)

**Assets.** Students' resumes, interview answers, scores, learning paths, mentor memory and account data; the
Gemini API key and other server secrets; the language-model budget.

**Trust boundaries.**
1. Browser to API: every request is untrusted. Identity comes only from a verified Firebase ID token.
2. API to the language model: everything a student typed is untrusted text inside the prompt.
3. API to the store (memory or Firestore): server-only; Firestore rules deny all client access (`firestore.rules`).

**Main risks and what stops them**

| Risk | Control | Code | Test |
|---|---|---|---|
| Reading another student's data | Every route after `requireAuth` is private by default; owner comes from the token, never the request | `backend/src/app.ts:139` | `tests/integration/routeAudit.test.ts` "refuses a missing, malformed or invalid token on every private route, with no detail"; `tests/integration/tenantIsolation.test.ts` "Bob never sees any of Alice's data on any read route" |
| Malformed or oversized input | Strict zod schemas (unknown keys rejected; 74 `strictObject` uses in `backend/src`) and a 100 kB JSON limit | `backend/src/app.ts:110` | `tests/integration/learningPath.test.ts` "rejects bad input with the contract error shape" |
| Prompt injection | Student text is wrapped in tags it cannot close and declared untrusted | `backend/src/llm/prompts/shared.ts:10-17` | `tests/integration/security.test.ts` "prompt-injection defenses" |
| A fooled model passing a student | Evidence guard: a criterion passes only with a verbatim quote from the answer; scores and verdicts are computed in code | `backend/src/core/evidence.ts:21-36` | `tests/unit/evidence.test.ts` "evidence guard" |
| Model deciding a learning path | SkillForge decisions (gaps, order, adaptation, routing) are pure code; the model only words the mentor message from a facts object | `backend/src/agents/orchestrator.ts` (`ROUTES`), `backend/src/core/adapt.ts` | `tests/unit/agents.test.ts` "routing table"; `tests/integration/learningPath.test.ts` "uses the AI model for wording only, and labels it" |
| A client forging a "real" score | `source: "interrogation"` takes no score; the server reads the student's own graded results and ignores demo-model grading | `backend/src/learning/service.ts` (`assess`) | `tests/integration/learningPath.test.ts` "refuses a real result that does not exist, and ignores demonstration-graded results" |
| Abuse and cost | Per-IP global limit (300/min) and LLM-route limit (40/min), per-student limiters, and a per-student daily model budget (default 150) | `backend/src/middleware/rateLimit.ts:32`, `backend/src/security/budget.ts:18`, `backend/src/config.ts:120` | `tests/integration/securityLayers.test.ts` "daily language-model budget"; `tests/integration/code.test.ts` "limits a user to two runs in flight and rate limits per user, not per address" |
| Browser attacks | helmet security headers; CORS allow-list (`*` refused in production) | `backend/src/app.ts:107-108` | `tests/integration/errors.test.ts` "sets security headers and hides the framework"; `tests/integration/cors.test.ts` "CORS allow-list" |
| Demo settings reaching production | `AUTH_MODE=mock`, emulator hosts and the unlicensed local DSA catalogue are refused when `NODE_ENV=production` | `backend/src/config.ts:194-199`, `backend/src/dsa/catalogue.ts:99-100` | `tests/unit/mockAuth.test.ts` "AUTH_MODE config"; `tests/unit/dsaCatalogue.test.ts` "is accepted outside production and refused in production" |

## Secrets

- Secrets come only from environment variables (locally a gitignored `.env`; in production a secret store).
  `.env`, `.env.*` are gitignored; only `.env.example` files are tracked.
- Logs redact API keys, tokens, client secrets and the `Authorization` header (`backend/src/logger.ts:22-30`;
  `tests/unit/logger.test.ts` "never writes API keys, tokens, client secrets or the Authorization header").
- The frontend bundle holds only public Firebase web config. Hidden code-judging test inputs are checked to be
  absent from the built bundle (`tests/unit/practicePack.test.ts` "never contains hidden test inputs").

Checks run for this file (14 Nov 2026), each returning nothing:

```bash
git ls-files | grep -iE '(^|/)\.env$|serviceaccount|\.pem$|\.key$'
git grep -nE 'AIza[0-9A-Za-z_-]{30,}|-----BEGIN .*PRIVATE KEY'
git log --all -G'AIza[0-9A-Za-z_-]{30,}|-----BEGIN .*PRIVATE KEY' --format=%h
```

## Dependencies

`npm audit --omit=dev` (production dependencies) reports 0 vulnerabilities in `backend/` and `frontend/` as of
14 Nov 2026, after updating the transitive `fast-xml-parser` (backend) and `re2js` (frontend) to fixed versions.
Advisories remain in **development-only** tooling (`vitest`/`vite` used by tests, `typescript-eslint`, `eslint`);
npm marks every available fix as a semver-major upgrade, so they are not forced here. They are not part of the
deployed server or the built site. CI runs `npm audit --omit=dev --audit-level=high` on the backend
(`.github/workflows/ci.yml`).

## Known limits

- Not deployed and verified in production from this repository state; App Check and token revocation are
  implemented but depend on deployment settings (`docs/security-and-launch.md`).
- No external penetration test or security review has been done.
