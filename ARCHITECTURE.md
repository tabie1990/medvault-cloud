# MedVAULT Cloud — Complete Architecture (Hetzner CX23 edition)

Covers: cloud API, offline Hospital HMS sync, Doctor App (telemedicine + lab
referrals + lab hosting), Patient App, Meta WhatsApp (WABA) AI agent, and how they
all sync through one engine. Written to replace the Azure-based design from the
original README while staying inside a €50-70/month hosting ceiling.

---

## 1. System diagram

```
┌────────────────┐        ┌─────────────────────┐        ┌───────────────────┐
│   Patient App   │        │   Doctor App          │        │  Web / Admin       │
│  (React Native) │        │  (React Native)        │        │  Portal            │
│                 │        │  - teleconsult          │        │                    │
│  - appointments │        │  - lab referrals         │        └─────────┬─────────┘
│  - lab results  │        │  - hosts a lab (own      │                  │
│  - teleconsult  │        │    home/on-site tests)   │                  │
│    join link    │        └───────────┬─────────────┘                  │
└────────┬────────┘                    │                                │
         │ REST (JWT, phone+OTP auth)  │ REST (JWT, doctor auth)        │ REST
         │                             │                                │
         ▼                             ▼                                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                    MedVAULT Cloud API — single Node process                   │
│                                                                                 │
│  Existing (Phase 1-6):              New (this phase):                         │
│  - hospitals / installations         - lab-providers (doctor-hosted labs)      │
│  - global patient identity           - lab-services (test catalog + pricing)   │
│  - sync push/pull (HMAC)             - lab-orders (referral → result)          │
│  - appointments                      - telemedicine sessions (Daily.co rooms)  │
│  - doctors                           - notifications (WhatsApp/push queue)     │
│                                       - whatsapp webhook + AI agent            │
│                                       - patient/doctor OTP auth                │
│                                                                                 │
│  In-process poller (no message broker): appointment fan-out, lab-order sync,   │
│  notification dispatch — all driven off Postgres tables, checked on an        │
│  interval inside this same process.                                           │
└───────────────────────┬─────────────────────────────────┬─────────────────────┘
                         │                                 │
                         ▼                                 ▼
              ┌─────────────────────┐          ┌─────────────────────────┐
              │   PostgreSQL 16      │          │  Meta WhatsApp Cloud API  │
              │   (same box)         │          │  webhook + AI agent       │
              └──────────┬───────────┘          │  (Claude Haiku, tool-use) │
                         │                       └─────────────┬─────────────┘
                         │ sync pull/push (HMAC-signed)          │
                         ▼                                       ▼
              ┌─────────────────────────┐              ┌───────────────────┐
              │  Offline Hospital HMS     │              │  WhatsApp patients  │
              │  (SQLite, per-hospital PC)│              │  (book, ask, check  │
              │  pulls sync events when   │              │   lab results)      │
              │  it comes online          │              └───────────────────┘
              └─────────────────────────┘
```

One Node process, one Postgres database, on one Hetzner CX23. Every new actor
(doctor app, patient app, WhatsApp) is just another authenticated client of the same
API — no new servers, no message broker, no per-feature infrastructure.

---

## 2. New data model

Add to `prisma/schema.prisma`. Nothing in the existing schema needs to change —
these are additive models plus a few relation fields on `Doctor`, `Hospital`,
`GlobalPatient`, and `Appointment`.

```prisma
enum LabServiceType     { home_visit on_site both }
enum LabOrderStatus     { requested scheduled sample_collected in_progress completed cancelled }
enum TelemedicineStatus { scheduled ongoing completed cancelled no_show }
enum NotificationChannel { whatsapp push sms email }
enum NotificationStatus  { pending sent failed }

model LabProvider {
  id                 String   @id @default(uuid()) @db.Uuid
  providerRef        String   @unique
  name               String
  ownerDoctorId      String?  @db.Uuid   // a doctor hosting their own lab
  hospitalId         String?             // OR a hospital-affiliated lab
  serviceType        LabServiceType @default(on_site)
  homeServiceFee     Decimal? @default(0)
  city               String?
  region             String?
  verificationStatus VerificationStatus @default(pending)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
  ownerDoctor        Doctor?   @relation(fields: [ownerDoctorId], references: [id])
  hospital           Hospital? @relation(fields: [hospitalId], references: [hospitalId])
  services           LabService[]
  orders             LabOrder[]
}

model LabService {
  id              String  @id @default(uuid()) @db.Uuid
  labProviderId   String  @db.Uuid
  testName        String
  testCode        String?
  basePrice       Decimal
  turnaroundHours Int?    @default(24)
  isActive        Boolean @default(true)
  createdAt       DateTime @default(now())
  labProvider     LabProvider @relation(fields: [labProviderId], references: [id])
  orderItems      LabOrderItem[]
}

model LabOrder {
  id                    String   @id @default(uuid()) @db.Uuid
  orderRef              String   @unique
  globalPatientId       String?
  hospitalId            String?
  referringDoctorId     String?  @db.Uuid
  referralAppointmentId String?  @db.Uuid
  labProviderId         String   @db.Uuid
  serviceType           LabServiceType
  homeAddress           String?
  scheduledDate         DateTime?
  scheduledTime         String?
  status                LabOrderStatus @default(requested)
  totalCost             Decimal?
  paymentStatus         String?  @default("unpaid")
  resultPayload         Json?
  source                String   // patient_app | doctor_app | whatsapp_ai | hospital_hms
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt
  globalPatient         GlobalPatient? @relation(fields: [globalPatientId], references: [globalPatientId])
  hospital              Hospital?      @relation(fields: [hospitalId], references: [hospitalId])
  referringDoctor       Doctor?        @relation(fields: [referringDoctorId], references: [id])
  referralAppointment   Appointment?   @relation(fields: [referralAppointmentId], references: [id])
  labProvider           LabProvider    @relation(fields: [labProviderId], references: [id])
  items                 LabOrderItem[]

  @@index([globalPatientId])
  @@index([labProviderId, status])
}

model LabOrderItem {
  id           String  @id @default(uuid()) @db.Uuid
  labOrderId   String  @db.Uuid
  labServiceId String  @db.Uuid
  priceAtOrder Decimal
  labOrder     LabOrder   @relation(fields: [labOrderId], references: [id])
  labService   LabService @relation(fields: [labServiceId], references: [id])
}

model TelemedicineSession {
  id              String  @id @default(uuid()) @db.Uuid
  sessionRef      String  @unique
  appointmentId   String  @unique @db.Uuid
  doctorId        String? @db.Uuid
  globalPatientId String?
  roomProvider    String  @default("daily.co")
  roomUrl         String?
  status          TelemedicineStatus @default(scheduled)
  startedAt       DateTime?
  endedAt         DateTime?
  createdAt       DateTime @default(now())
  appointment     Appointment    @relation(fields: [appointmentId], references: [id])
  doctor          Doctor?        @relation(fields: [doctorId], references: [id])
  globalPatient   GlobalPatient? @relation(fields: [globalPatientId], references: [globalPatientId])
}

model Notification {
  id            String  @id @default(uuid()) @db.Uuid
  channel       NotificationChannel
  recipientType String  // patient | doctor
  recipientRef  String  // globalPatientId or doctorRef
  templateType  String  // appointment_confirmed | lab_result_ready | ...
  payload       Json
  status        NotificationStatus @default(pending)
  errorMessage  String?
  sentAt        DateTime?
  createdAt     DateTime @default(now())

  @@index([status])
}

model WhatsAppContact {
  id                String   @id @default(uuid()) @db.Uuid
  waPhoneNumber     String   @unique
  globalPatientId   String?
  conversationState Json?    // short-lived state for the AI agent's tool-use loop
  lastInteractionAt DateTime?
  createdAt         DateTime @default(now())
  globalPatient     GlobalPatient? @relation(fields: [globalPatientId], references: [globalPatientId])
}

model DeviceToken {
  id        String @id @default(uuid()) @db.Uuid
  ownerType String // patient | doctor
  ownerRef  String // globalPatientId or doctorRef
  platform  String // ios | android
  pushToken String
  createdAt DateTime @default(now())

  @@unique([ownerType, ownerRef, pushToken])
}
```

Add the inverse relation arrays (`labProviders`, `labOrders`, `telemedicineSessions`,
`whatsAppContacts`, etc.) to the existing `Doctor`, `Hospital`, `GlobalPatient`, and
`Appointment` models where referenced above.

---

## 3. New API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/patients/request-otp` | Patient app / WhatsApp: send a one-time code by WhatsApp to a phone number |
| `POST /api/v1/patients/verify-otp` | Exchange the code for a JWT + `global_patient_id` |
| `POST /api/v1/doctors/login` | Doctor app auth (password or OTP → JWT) |
| `GET  /api/v1/patients/:globalPatientId/timeline` | Unified feed for the patient app: appointments + lab orders + telemedicine, one call |
| `POST /api/v1/lab-providers/register` | A doctor (or hospital) hosts a lab: home-visit and/or on-site |
| `POST /api/v1/lab-providers/:id/services` | Add a test to that lab's price catalog |
| `GET  /api/v1/lab-providers` | Browse labs by city / service type (patient app, doctor app, WhatsApp agent) |
| `POST /api/v1/lab-orders` | Create a referral — from a teleconsult, a direct patient booking, or the WhatsApp agent |
| `GET  /api/v1/lab-orders/:id` | Status + results |
| `PATCH /api/v1/lab-orders/:id` | Lab updates status (`sample_collected`, `in_progress`, `completed` + `resultPayload`) |
| `POST /api/v1/telemedicine/sessions` | Create a video room for a `teleconsult` appointment (wraps Daily.co, same provider your offline HMS already uses) |
| `PATCH /api/v1/telemedicine/sessions/:id` | Start / end a session |
| `POST /api/v1/notifications/register-device` | Patient/doctor app registers a push token |
| `GET|POST /api/v1/whatsapp/webhook` | Meta's webhook verification (GET) and inbound messages (POST) |

All of these live as route files in `src/routes/` in the delivered package —
no new deployable app, no new server.

---

## 4. Sync event types (extends the existing `SyncEvent.eventType` string field —
no schema change needed, just new values in use)

| Event type | Direction | Meaning |
|---|---|---|
| `lab_order.created` | `cloud_to_hospital` | A referral was made for a patient this hospital owns |
| `lab_order.completed` | `cloud_to_hospital` | Result is ready; payload carries `resultPayload` |
| `telemedicine.session.completed` | `cloud_to_hospital` | Teleconsult finished; hospital record gets the note/outcome |

Same idempotency guarantee as today (`event_id` unique per hospital + installation).

---

## 5. In-process job handling (no message broker)

Following the earlier cost redesign: everything below runs as `setInterval` polling
functions inside the single Node process (`src/jobs/poller.ts` in the delivered
package) — not separate workers, not Service Bus.

- **Appointment → sync fan-out** (existing logic, already planned)
- **Lab order → sync fan-out**: same pattern — new `lab_order.created`/`completed`
  rows get turned into `cloud_to_hospital` `SyncEvent`s
- **Notification dispatch**: a poller reads `Notification` rows with
  `status = 'pending'`, sends via WhatsApp Cloud API or push (Expo/FCM/APNs), marks
  `sent`/`failed`

If volume ever genuinely outgrows single-process polling, each poller function is
already isolated and can be lifted into a real worker later — but don't build that
until you have the traffic to justify it.

---

## 6. Doctor App & Patient App — recommended build

**Stack:** React Native (Expo) for both apps. Reasons: one codebase style for a
small/solo team, Expo's managed push notifications are free, and Daily.co (your
existing telemedicine provider) has a React Native SDK, so you're not re-choosing a
video vendor.

**Two separate apps, not one with role switching** — a doctor's app needs to see
which patients they treat and manage a lab catalog; a patient's app should never be
able to see other patients' data or a doctor's business tools. Keeping them separate
binaries makes that boundary structural, not just a UI toggle.

**Doctor App — core screens:**
1. Login (phone/email + OTP or password)
2. Appointment queue (teleconsult + in-person), tap to start a Daily.co video call
3. During/after a consult: "Refer to lab" → pick tests from a lab's catalog → creates
   a `LabOrder`
4. "My Lab" (optional): if this doctor hosts a lab, a simple catalog editor (add
   test, set price, toggle home-visit availability) and an incoming-orders queue to
   update status/upload results
5. Patient lookup by `global_patient_id` or phone (read-only chart summary, not full
   HMS record — cloud only stores what Phase 1-6 already synced)

**Patient App — core screens:**
1. Phone number → WhatsApp OTP login (same OTP mechanism as the WhatsApp agent uses
   — one code path, not two)
2. Timeline: upcoming appointments, past visits, lab results as they land
3. "Book" → teleconsult or a lab test (home visit or on-site), browsing labs by
   city/price
4. Push notifications for: appointment confirmed, lab result ready, teleconsult
   starting soon

**Offline behavior:** unlike the hospital HMS, mobile apps can assume intermittent
rather than no connectivity. Cache the last-fetched timeline locally (SQLite via
`expo-sqlite`, or simple `AsyncStorage` for a read-only cache) so the last-known state
still displays with no signal; queue writes (bookings) and retry on reconnect. This
is the same idea as your HMS sync agent, scaled down — you don't need a second
offline-sync protocol, just a local cache-and-retry layer talking to the same REST
API described above.

---

## 7. Meta WhatsApp (WABA) AI agent

- Use the **WhatsApp Cloud API** (Meta's own hosted version — not the older on-prem
  Business API, which you don't want to be running yourself).
- One webhook on your existing server: `POST /api/v1/whatsapp/webhook`. Meta verifies
  it via a `GET` challenge on setup, then posts inbound messages to it.
- Inbound message handling: look up or create a `WhatsAppContact` by phone number,
  then call an LLM (**Claude Haiku 4.5 recommended** — cheapest capable model, good
  fit for a bounded conversational task) with a small tool-use set:
  `create_appointment`, `create_lab_order`, `check_lab_order_status`,
  `escalate_to_human`. The agent calls your *existing* internal service functions
  (the same ones your route handlers call) — it never gets its own separate write
  path into the database.
- Outbound replies and proactive messages (appointment confirmations, "your result is
  ready") go through the `Notification` table/poller above, using WhatsApp's message
  templates for anything business-initiated (Meta requires pre-approved templates
  for messages you send outside a customer-initiated 24-hour window).

**Cost note — this is separate from your hosting bill:** WhatsApp Cloud API includes
a monthly free tier of service conversations, then charges per conversation by
category and country after that; LLM calls are billed per token. Both are
usage-based operational costs, not part of the €50-70 hosting ceiling — budget for
them separately once you know real conversation volume. Neither requires a new
server: both are just outbound API calls from the same Node process.

---

## 8. Updated cost picture

| Item | Cost |
|---|---|
| Hetzner CX23 (2 vCPU / 4GB / 40GB) — API + Postgres + all new modules, same box | ~€7-9/month |
| Backblaze B2 (nightly encrypted Postgres backups) | ~€1/month |
| Expo push notifications (patient + doctor apps) | Free |
| Daily.co video (teleconsult) | Free up to 10,000 min/month, then ~$0.001/min |
| **Hosting total** | **~€8-10/month**, ~€40-62 under your ceiling |
| *Separate, usage-based (not hosting):* WhatsApp Cloud API conversations | Pay-per-conversation after free tier — track once live |
| *Separate, usage-based (not hosting):* Claude Haiku tokens for the WhatsApp agent | Small, per-message — track once live |

Adding doctors, patients, telemedicine, and lab referrals doesn't move your hosting
cost — it's all the same single process and database. The only real new recurring
costs are WhatsApp conversations and LLM tokens, both usage-based and worth watching
once you have real traffic, but neither requires new infrastructure.

---

## 9. What this does *not* include yet (intentionally, next-phase items)

- Payments (MoMo/Orange Money for lab-test fees) — your HMS already integrates
  Campay; the cloud side would need the equivalent, deliberately left out of this
  pass to keep scope contained.
- Doctor/lab payout and reconciliation logic.
- Full JWT auth middleware + rate limiting on the new endpoints (needed before any
  of this touches real patient data — flagged, not built, in this pass).
- Actual React Native app scaffolding (this document specifies the architecture and
  screens; building the Expo projects themselves is a follow-up task).
