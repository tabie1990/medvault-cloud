import PDFDocument from 'pdfkit';
import { prisma } from '../db/prisma.js';
import { uploadBuffer, getDownloadUrl } from './storage.service.js';

const STATUS_LABELS: Record<string, string> = {
  administered: 'Administered (clinically verified)',
  parent_reported: 'Reported by guardian (not yet verified)',
  proof_submitted: 'Proof submitted (pending verification)',
  overdue: 'Overdue',
  due: 'Due',
  skipped: 'Skipped'
};

/**
 * Builds a one-page vaccination report PDF for a child, uploads it to
 * storage, and returns a short-lived download URL ready to hand to
 * sendDocumentMessage. Deliberately shows the real status label for
 * every dose — including the guardian-reported vs. clinically-verified
 * distinction — rather than collapsing everything into a simple
 * given/not-given checklist, since that distinction is the whole point
 * of tracking it separately in the first place.
 */
export async function generateVaccinationReportPdf(childPatientId: string): Promise<{ url: string; filename: string } | null> {
  const child = await prisma.globalPatient.findUnique({ where: { globalPatientId: childPatientId } });
  if (!child) return null;

  const records = await prisma.vaccinationRecord.findMany({
    where: { childPatientId },
    include: { scheduleItem: true },
    orderBy: { scheduledDate: 'asc' }
  });

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(18).fillColor('#1B2A4A').text('MedVAULT Vaccination Report', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#6B6558').text(`Generated ${new Date().toLocaleDateString('en-GB')}`);
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#000000').text(child.fullName ?? 'Unknown');
  doc.fontSize(10).fillColor('#6B6558').text(`MedVAULT ID: ${child.globalPatientId}`);
  if (child.dob) doc.text(`Date of birth: ${new Date(child.dob).toLocaleDateString('en-GB')}`);
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#1B2A4A').text('Vaccination history', { underline: true });
  doc.moveDown(0.5);

  for (const r of records) {
    const label = STATUS_LABELS[r.status] ?? r.status;
    const date = r.administeredAt ?? r.reportedDate ?? r.scheduledDate;
    doc.fontSize(10).fillColor('#000000').text(
      `${r.scheduleItem.vaccineName}  —  ${label}  —  ${new Date(date).toLocaleDateString('en-GB')}`
    );
  }

  doc.end();
  const buffer = await done;

  const filename = `${child.fullName?.replace(/[^a-zA-Z0-9]/g, '_') ?? 'child'}-vaccination-report.pdf`;
  const { key } = await uploadBuffer('vaccination-reports', filename, 'application/pdf', buffer);
  const url = await getDownloadUrl(key);
  return { url, filename };
}
