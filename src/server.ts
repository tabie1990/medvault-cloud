import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { ensureSequences } from './db/prisma.js';
import { startPollers } from './jobs/poller.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';

import { hospitalsRouter } from './routes/hospitals.routes.js';
import { syncRouter } from './routes/sync.routes.js';
import { appointmentsRouter } from './routes/appointments.routes.js';
import { doctorsRouter } from './routes/doctors.routes.js';
import { patientsRouter } from './routes/patients.routes.js';
import { labProvidersRouter } from './routes/lab-providers.routes.js';
import { labOrdersRouter } from './routes/lab-orders.routes.js';
import { telemedicineRouter } from './routes/telemedicine.routes.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { whatsappRouter } from './routes/whatsapp.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { adminRouter } from './routes/admin.routes.js';

const app = express();
// Nginx sits in front of this app (see setup-server.sh) and adds
// X-Forwarded-For — without this, express-rate-limit can't tell real
// client IPs apart from Nginx's own, which either breaks rate limiting
// entirely or throws on every rate-limited request. `1` trusts exactly
// one hop (the Nginx reverse proxy), not an arbitrary chain.
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));
app.use(
  express.json({
    limit: '5mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    }
  })
);

const openApi = {
  openapi: '3.0.0',
  info: { title: 'MedVAULT Cloud API', version: '2.0.0' },
  paths: {
    '/health': { get: { responses: { '200': { description: 'OK' } } } },
    '/api/v1/hospitals/register': { post: { summary: 'Register hospital' } },
    '/api/v1/hospitals/installations/activate': { post: { summary: 'Activate offline installation' } },
    '/api/v1/sync/push': { post: { summary: 'Push offline HMS events to cloud (HMAC-signed)' } },
    '/api/v1/sync/pull': { get: { summary: 'Pull pending cloud events for hospital' } },
    '/api/v1/appointments': { post: { summary: 'Create appointment from any source' } },
    '/api/v1/appointments/hospital/{hospitalId}/pending': { get: { summary: 'Pending appointments for a hospital' } },
    '/api/v1/doctors/register': { post: { summary: 'Register a doctor' } },
    '/api/v1/doctors/login': { post: { summary: 'Doctor login (JWT)' } },
    '/api/v1/doctors/me': { get: { summary: 'Current doctor profile (auth required)' } },
    '/api/v1/patients/request-otp': { post: { summary: 'Send WhatsApp OTP to a patient phone number' } },
    '/api/v1/patients/verify-otp': { post: { summary: 'Verify OTP, returns patient JWT' } },
    '/api/v1/patients/{globalPatientId}/timeline': { get: { summary: 'Unified patient timeline (auth required)' } },
    '/api/v1/lab-providers/register': { post: { summary: 'A doctor hosts a lab (auth required)' } },
    '/api/v1/lab-providers/{id}/services': { post: { summary: 'Add a test to a lab catalog (auth required)' } },
    '/api/v1/lab-providers': { get: { summary: 'Browse labs by city/service type' } },
    '/api/v1/lab-providers/{id}': { get: { summary: 'Lab provider detail + catalog' } },
    '/api/v1/lab-orders': { post: { summary: 'Create a lab referral/order (auth required)' } },
    '/api/v1/lab-orders/{id}': {
      get: { summary: 'Lab order status/result (auth required)' },
      patch: { summary: 'Update lab order status/result (doctor auth required)' }
    },
    '/api/v1/lab-orders/hospital/{hospitalId}/pending': { get: { summary: 'Pending lab orders for a hospital' } },
    '/api/v1/telemedicine/sessions': { post: { summary: 'Create a video session for a teleconsult (doctor auth)' } },
    '/api/v1/telemedicine/sessions/{id}': {
      get: { summary: 'Session detail (auth required)' },
      patch: { summary: 'Start/end/cancel a session (doctor auth)' }
    },
    '/api/v1/notifications/register-device': { post: { summary: 'Register a push token (auth required)' } },
    '/api/v1/whatsapp/webhook': {
      get: { summary: "Meta's webhook verification handshake" },
      post: { summary: 'Inbound WhatsApp messages -> AI agent' }
    },
    '/api/v1/auth/login': { post: { summary: 'Unified login for doctor, lab-staff, and admin accounts' } },
    '/api/v1/auth/change-password': { post: { summary: 'Change password (admin or lab-staff auth required)' } },
    '/api/v1/doctors/change-password': { post: { summary: 'Change password (doctor auth required)' } },
    '/api/v1/doctors/kyc/upload-url': { post: { summary: 'Get a presigned upload URL for a KYC document (doctor auth)' } },
    '/api/v1/doctors/kyc': { post: { summary: 'Submit doctor KYC documents (doctor auth)' } },
    '/api/v1/lab-providers/{id}/kyc/upload-url': { post: { summary: 'Presigned upload URL for lab KYC (owner doctor auth)' } },
    '/api/v1/lab-providers/{id}/kyc': { post: { summary: 'Submit lab KYC documents (owner doctor auth)' } },
    '/api/v1/lab-providers/{id}/staff': {
      post: { summary: 'Create a lab-staff login for this lab (owner doctor auth)' },
      get: { summary: 'List this lab\'s staff (owner doctor auth)' }
    },
    '/api/v1/admin/kyc/pending': { get: { summary: 'Pending doctor/lab KYC submissions (admin auth)' } },
    '/api/v1/admin/kyc/doctors/{id}/decision': { post: { summary: 'Approve/reject a doctor\'s KYC (admin auth)' } },
    '/api/v1/admin/kyc/lab-providers/{id}/decision': { post: { summary: 'Approve/reject a lab\'s KYC (admin auth)' } }
  }
};

app.get('/health', (_req, res) => res.json({ ok: true, service: 'medvault-cloud-api', node: process.version }));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApi));

app.use('/api/v1/hospitals', hospitalsRouter);
app.use('/api/v1/sync', syncRouter);
app.use('/api/v1/appointments', appointmentsRouter);
app.use('/api/v1/doctors', doctorsRouter);
app.use('/api/v1/patients', patientsRouter);
app.use('/api/v1/lab-providers', labProvidersRouter);
app.use('/api/v1/lab-orders', labOrdersRouter);
app.use('/api/v1/telemedicine', telemedicineRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/whatsapp', whatsappRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/admin', adminRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function main() {
  await ensureSequences();
  app.listen(env.port, () => {
    console.log(`MedVAULT Cloud API listening on ${env.port} (${env.nodeEnv})`);
    startPollers();
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
