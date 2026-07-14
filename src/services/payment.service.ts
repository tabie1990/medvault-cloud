import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import * as campay from './campay.service.js';

export async function requestPayment(appointmentId: string, phone: string, amount: number) {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw new Error('appointment_not_found');

  const cleanPhone = campay.normalizeCameroonPhone(phone);
  const data = await campay.collect(
    cleanPhone,
    amount,
    `MedVAULT teleconsult — ${appointment.appointmentRef}`,
    `mv-appt-${appointment.appointmentRef}`
  );

  await prisma.appointment.update({
    where: { id: appointmentId },
    data: {
      paymentStatus: 'pending',
      paymentReference: data.reference,
      paymentAmount: amount,
      paymentPhone: cleanPhone
    }
  });

  return data;
}

export async function checkPaymentStatus(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appointment) throw new Error('appointment_not_found');
  if (!appointment.paymentReference) return { status: 'unpaid' };

  // Already confirmed — no need to re-poll Campay once we already know the outcome.
  if (appointment.paymentStatus === 'paid') {
    return { status: 'paid', reference: appointment.paymentReference };
  }

  const { status, raw } = await campay.checkTransactionStatus(appointment.paymentReference);

  if (status === 'SUCCESSFUL') {
    await prisma.appointment.update({ where: { id: appointmentId }, data: { paymentStatus: 'paid' } });
  } else if (status === 'FAILED') {
    await prisma.appointment.update({ where: { id: appointmentId }, data: { paymentStatus: 'unpaid' } });
  }

  return {
    status: status === 'SUCCESSFUL' ? 'paid' : status === 'FAILED' ? 'unpaid' : 'pending',
    reference: appointment.paymentReference,
    raw
  };
}

/** Manual override for cash/in-person payment before a teleconsult. */
export async function markPaid(appointmentId: string, amount: number) {
  return prisma.appointment.update({
    where: { id: appointmentId },
    data: { paymentStatus: 'paid', paymentAmount: amount }
  });
}

/**
 * Splits a confirmed patient payment: MedVAULT's platform fee, and the
 * remainder to the doctor (or the hospital, if the doctor has no MoMo of
 * their own on file). Mirrors the HMS's own split logic exactly, including
 * the double-disbursement guard.
 */
export async function splitPayout(appointmentId: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { doctor: true, hospital: true }
  });
  if (!appointment) throw new Error('appointment_not_found');
  if (appointment.paymentStatus !== 'paid') throw new Error('patient_has_not_paid_yet');

  const existingSplit = await prisma.paymentSplit.findFirst({
    where: { appointmentId, status: { not: 'failed' } }
  });
  if (existingSplit?.status === 'completed') {
    return { alreadySplit: true, split: existingSplit };
  }

  const totalAmount = Number(appointment.paymentAmount ?? 0);
  const platformFeePct = env.platformFeePct;
  const platformAmount = Math.round((totalAmount * platformFeePct) / 100);
  const providerAmount = totalAmount - platformAmount;

  const providerMomo = appointment.doctor?.momoNumber ?? appointment.hospital?.hospitalMomoNumber;
  const providerNetwork = appointment.doctor?.momoNetwork ?? appointment.hospital?.hospitalMomoNetwork ?? 'MTN';

  if (!env.medvaultMomoNumber) throw new Error('medvault_momo_number_not_configured');
  if (!providerMomo) throw new Error('no_momo_number_found_for_doctor_or_hospital');

  const split = await prisma.paymentSplit.create({
    data: {
      appointmentId,
      totalAmount,
      platformFeePct,
      platformAmount,
      providerAmount,
      medvaultMomo: env.medvaultMomoNumber,
      providerMomo,
      providerNetwork,
      patientPaymentRef: appointment.paymentReference
    }
  });

  try {
    const platformRes = await campay.transfer(
      env.medvaultMomoNumber,
      platformAmount,
      `MedVAULT platform fee — ${appointment.appointmentRef}`,
      `mv-platform-${appointment.appointmentRef}`
    );
    const providerRes = await campay.transfer(
      providerMomo,
      providerAmount,
      `Teleconsult payout — ${appointment.appointmentRef}`,
      `mv-provider-${appointment.appointmentRef}`
    );

    const bothOk = platformRes.ok && providerRes.ok;
    await prisma.paymentSplit.update({
      where: { id: split.id },
      data: {
        platformPayoutRef: platformRes.data.reference ?? null,
        providerPayoutRef: providerRes.data.reference ?? null,
        status: bothOk ? 'completed' : 'failed',
        completedAt: bothOk ? new Date() : null
      }
    });

    if (!bothOk) {
      const err: any = new Error('one_or_more_payout_transfers_failed');
      err.platform = platformRes.data;
      err.provider = providerRes.data;
      throw err;
    }

    return {
      platformAmount,
      providerAmount,
      platformRef: platformRes.data.reference,
      providerRef: providerRes.data.reference
    };
  } catch (err) {
    await prisma.paymentSplit.update({ where: { id: split.id }, data: { status: 'failed' } });
    throw err;
  }
}
