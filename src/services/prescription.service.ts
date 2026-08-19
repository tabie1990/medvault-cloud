import { prisma } from '../db/prisma.js';
import { generateRef } from './id.service.js';
import PDFDocument from 'pdfkit';
import { uploadBuffer, getDownloadUrl, getObjectBytes } from './storage.service.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Read once at module load, not per-PDF — this is a static brand asset,
// not something that changes per request. Same repo-root-relative
// pattern as SYSTEM_PROMPT in ai-agent.service.ts: untouched by tsc,
// reachable the same way from compiled dist/ output.
const LOGO_PATH = join(__dirname, '../../assets/medvault-logo.png');
let logoBuffer: Buffer | null = null;
try {
  logoBuffer = readFileSync(LOGO_PATH);
} catch {
  // Missing asset shouldn't ever break prescription generation — the PDF
  // just renders without the logo if it's not there.
  logoBuffer = null;
}

interface PrescriptionItem {
  type: 'medication' | 'lab_request' | 'imaging_request';
  name: string;
  dose?: string;
  frequency?: string;
  duration?: string;
  notes?: string;
}

export async function createPrescription(input: {
  appointmentId: string;
  doctorId: string;
  symptoms?: string;
  diagnosis?: string;
  notes?: string;
  items: PrescriptionItem[];
}) {
  const appointment = await prisma.appointment.findUnique({ where: { id: input.appointmentId } });
  if (!appointment) throw new Error('appointment_not_found');
  if (!input.items || input.items.length === 0) throw new Error('at_least_one_item_is_required');

  return prisma.prescription.create({
    data: {
      prescriptionRef: generateRef('MVRX'),
      appointmentId: input.appointmentId,
      globalPatientId: appointment.globalPatientId ?? undefined,
      doctorId: input.doctorId,
      symptoms: input.symptoms,
      diagnosis: input.diagnosis,
      notes: input.notes,
      items: input.items as any
    }
  });
}

export async function getPrescriptionsForAppointment(appointmentId: string) {
  return prisma.prescription.findMany({ where: { appointmentId }, orderBy: { createdAt: 'desc' } });
}

export async function getPrescriptionsForPatient(globalPatientId: string) {
  return prisma.prescription.findMany({ where: { globalPatientId }, orderBy: { createdAt: 'desc' } });
}

export async function markPrescriptionSent(id: string) {
  return prisma.prescription.update({ where: { id }, data: { status: 'sent_to_patient', sentAt: new Date() } });
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  medication: 'Medication',
  lab_request: 'Lab Request',
  imaging_request: 'Imaging Request'
};

/**
 * Builds the prescription PDF, embedding the doctor's own signature and
 * stamp images if they've uploaded them (private B2 objects, read
 * server-side only via getObjectBytes — never a public URL, since a
 * signature/stamp image is exactly the kind of thing that shouldn't be
 * fetchable by anyone who guesses or intercepts a link the way the
 * profile photo can be). Follows the same PDFDocument-to-buffer-to-B2-
 * upload pattern as generateVaccinationReportPdf — same reasoning:
 * upload once, hand back a URL ready for sendDocumentMessage.
 */
export async function generatePrescriptionPdf(prescriptionId: string): Promise<{ url: string; filename: string } | null> {
  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: { doctor: true }
  });
  if (!prescription) return null;

  const patient = prescription.globalPatientId
    ? await prisma.globalPatient.findUnique({ where: { globalPatientId: prescription.globalPatientId } })
    : null;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  if (logoBuffer) {
    try {
      doc.image(logoBuffer, 50, 45, { width: 160 });
      doc.moveDown(3);
    } catch {
      // Corrupted/unsupported logo file — skip rather than fail the
      // whole prescription over a header image.
    }
  }

  doc.fontSize(18).fillColor('#1B2A4A').text('MedVAULT Prescription', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#6B6558').text(`Ref: ${prescription.prescriptionRef}  —  ${new Date(prescription.createdAt).toLocaleDateString('en-GB')}`);
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#1B2A4A').text('Doctor', { underline: true });
  doc.fontSize(10).fillColor('#000000').text(prescription.doctor.fullName ?? 'Unknown');
  if (prescription.doctor.specialty) doc.fillColor('#6B6558').text(prescription.doctor.specialty);
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#1B2A4A').text('Patient', { underline: true });
  doc.fontSize(10).fillColor('#000000').text(patient?.fullName ?? 'Unknown');
  if (patient?.dob) doc.fillColor('#6B6558').text(`DOB: ${new Date(patient.dob).toLocaleDateString('en-GB')}`);
  doc.moveDown(1);

  if (prescription.symptoms) {
    doc.fontSize(11).fillColor('#1B2A4A').text('Symptoms', { underline: true });
    doc.fontSize(10).fillColor('#000000').text(prescription.symptoms);
    doc.moveDown(0.7);
  }
  if (prescription.diagnosis) {
    doc.fontSize(11).fillColor('#1B2A4A').text('Diagnosis', { underline: true });
    doc.fontSize(10).fillColor('#000000').text(prescription.diagnosis);
    doc.moveDown(0.7);
  }

  doc.fontSize(11).fillColor('#1B2A4A').text('Prescribed', { underline: true });
  doc.moveDown(0.3);
  const items = (prescription.items as any[]) ?? [];
  for (const item of items) {
    const label = ITEM_TYPE_LABELS[item.type] ?? item.type;
    const detailParts = [item.dose, item.frequency, item.duration].filter(Boolean);
    const detail = detailParts.length ? ` — ${detailParts.join(', ')}` : '';
    doc.fontSize(10).fillColor('#000000').text(`•  [${label}] ${item.name}${detail}`);
    if (item.notes) doc.fontSize(9).fillColor('#6B6558').text(`    ${item.notes}`);
  }

  if (prescription.notes) {
    doc.moveDown(1);
    doc.fontSize(11).fillColor('#1B2A4A').text('Notes', { underline: true });
    doc.fontSize(10).fillColor('#000000').text(prescription.notes);
  }

  // Signature and stamp, side by side, near the bottom of the page —
  // only drawn if the doctor has actually uploaded them; a prescription
  // without either is still valid, just unsigned visually.
  doc.moveDown(2);
  const signatureY = doc.y;
  if (prescription.doctor.signatureKey) {
    const sig = await getObjectBytes(prescription.doctor.signatureKey);
    if (sig) {
      try {
        doc.image(sig.body, 50, signatureY, { width: 140 });
      } catch {
        // Malformed or unsupported image format — skip rather than fail
        // the whole PDF over a decorative element.
      }
    }
  }
  if (prescription.doctor.stampKey) {
    const stamp = await getObjectBytes(prescription.doctor.stampKey);
    if (stamp) {
      try {
        doc.image(stamp.body, 400, signatureY, { width: 100 });
      } catch {
        // See signature above.
      }
    }
  }

  doc.end();
  const buffer = await done;

  const filename = `prescription-${prescription.prescriptionRef}.pdf`;
  const { key } = await uploadBuffer('prescriptions', filename, 'application/pdf', buffer);
  const url = await getDownloadUrl(key);
  return { url, filename };
}
