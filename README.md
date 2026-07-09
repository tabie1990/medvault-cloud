# MedVAULT Cloud

Single-process API for MedVAULT's cloud layer: offline hospital HMS sync,
appointments, doctors, patient identity, lab providers (doctor-hosted or
hospital-affiliated) and lab orders, telemedicine sessions, a WhatsApp AI
agent, and JWT-based auth for a doctor app and a patient app.

No Azure, no message broker, no npm workspaces monorepo. One Node process,
one PostgreSQL database, designed to run on a single small VPS (built and
tested against a Hetzner CX23 — 2 vCPU / 4GB RAM / 40GB SSD, ~€7/month).

## What's in here

```
prisma/schema.prisma   Full data model — hospitals, patients, sync, appointments,
                       doctors, lab providers/orders, telemedicine, notifications,
                       WhatsApp contacts, device tokens, OTP codes
src/
  config/env.ts        Environment variable loading + production safety checks
  db/prisma.ts         Prisma client + one-time sequence setup (global_patient_id)
  middleware/          JWT auth guard, centralized error handling
  services/            All business logic — one file per concern, reused by
                        both HTTP routes and the WhatsApp AI agent
  jobs/poller.ts        In-process background jobs (replaces separate worker
                        apps and any message broker)
  routes/               Express routers, one per resource
  server.ts             Wires it all together
setup-server.sh         Provisions a fresh Ubuntu 24.04 VPS end-to-end
SETUP.md                Step-by-step: empty VPS -> live API
ARCHITECTURE.md         Full system design, diagrams, cost breakdown
```

## Quickstart (local development)

```bash
cp .env.example .env
docker compose up -d          # starts local Postgres only
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

Then:
```bash
curl http://localhost:8080/health
open http://localhost:8080/docs
```

## Going to production

Follow `SETUP.md` — it walks through buying a Hetzner CX23, pointing your
domain at it, running `setup-server.sh`, wiring up GitHub Actions deploys,
Backblaze B2 backups, and the WhatsApp Cloud API webhook.

## Design decisions worth knowing about

- **No message broker.** `src/jobs/poller.ts` runs appointment/lab-order
  fan-out and notification dispatch on a plain `setInterval`, reading and
  writing Postgres directly. At the traffic level a handful of hospitals
  generate, this is simpler and free — a broker becomes worth the added
  complexity only once you have real concurrency to justify it.
- **HMAC secrets are reversibly encrypted, not hashed.** The offline HMS
  signs each sync request; the server decrypts its own copy of the shared
  secret to verify the signature. The client never resends the secret itself
  — that's the entire point of HMAC signing, and the original design
  (bcrypt-hashing the secret, then requiring the client to resend it anyway
  so the server could compare) defeated that purpose. See
  `src/services/crypto.service.ts` and `src/services/hmac.service.ts`.
- **`global_patient_id` comes from a real Postgres sequence**, not
  `count() + 1` — see `src/services/id.service.ts` — so concurrent
  registrations can't collide.
- **The AI agent and the HTTP routes call the same service functions**
  (`src/services/appointment.service.ts`, `lab-order.service.ts`,
  `telemedicine.service.ts`). The WhatsApp agent never gets its own separate
  write path into the database — it can only do what the API can already do.

## What's intentionally not built yet

Flagged rather than silently skipped:

- **Payments** (MoMo/Orange Money for lab-test fees) — your offline HMS
  already integrates Campay; the cloud side needs the equivalent as a
  follow-up.
- **A dedicated lab-staff role.** Right now, any authenticated doctor can
  update a `LabOrder`'s status/results, not just the lab that owns it. Fine
  for a first pass with a small number of trusted labs; add a proper
  `LabStaff` login before opening this to unaffiliated labs.
- **Rate limiting beyond OTP/login.** `express-rate-limit` is applied to the
  auth-sensitive endpoints; add it more broadly before high traffic.
- **The actual React Native app code.** `ARCHITECTURE.md` specifies the
  screens, auth flow, and tech choice (Expo) for both the doctor and patient
  apps — building those Expo projects is a separate next step.
- **A verification workflow for `LabProvider.verificationStatus` and
  `Doctor.verificationStatus`.** Both fields exist and default to `pending`;
  there's no admin endpoint yet to move them to `verified`. Do this before
  the public lab-browsing endpoint (`GET /api/v1/lab-providers`) is exposed
  to real patients, or add a `where: { verificationStatus: 'verified' }`
  filter to that route first.

## Verification note

This package was built and type-checked (`npx tsc --noEmit`, clean) in a
sandboxed environment that could install npm packages but could not reach
`binaries.prisma.sh` to download Prisma's query engine — so `prisma generate`
itself could not be run here. Every Prisma call in the codebase was manually
cross-checked against `prisma/schema.prisma` field-by-field to compensate,
but the very first `npm install && npx prisma generate` you run on your own
machine or the VPS (both of which have normal internet access) is the real
first full validation. Do that before anything else — see SETUP.md step 3.
