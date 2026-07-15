import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';
import * as campay from './campay.service.js';

/**
 * Mirrors payment.service.ts exactly — same Campay integration, same
 * "collect the full amount, disburse the provider's share, MedVAULT keeps
 * the rest automatically" design established in Block 3. Applied to
 * LabOrder instead of Appointment; kept as a parallel file rather than a
 * shared generic implementation, since the two entities differ enough
 * (different relations, different payout fallback chain) that forcing a
 * shared abstraction would add more complexity than it saves.
 */

export async function requestLabPayment(labOrderId: string, phone: string, amount: number) {
  const order = await prisma.labOrder.findUnique({ where: { id: labOrderId } });
  if (!order) throw new Error('lab_order_not_found');

  const cleanPhone = campay.normalizeCameroonPhone(phone);
  const data = await campay.collect(
    cleanPhone,
    amount,
    `MedVAULT lab order — ${order.orderRef}`,
    `mv-lab-${order.orderRef}`
  );

  await prisma.labOrder.update({
    where: { id: labOrderId },
    data: {
      paymentStatus: 'pending',
      paymentReference: data.reference,
      paymentAmount: amount,
      paymentPhone: cleanPhone
    }
  });

  return data;
}

export async function checkLabPaymentStatus(labOrderId: string) {
  const order = await prisma.labOrder.findUnique({ where: { id: labOrderId } });
  if (!order) throw new Error('lab_order_not_found');
  if (!order.paymentReference) return { status: 'unpaid' };

  if (order.paymentStatus === 'paid') {
    return { status: 'paid', reference: order.paymentReference };
  }

  const { status, raw } = await campay.checkTransactionStatus(order.paymentReference);

  if (status === 'SUCCESSFUL') {
    await prisma.labOrder.update({ where: { id: labOrderId }, data: { paymentStatus: 'paid' } });
  } else if (status === 'FAILED') {
    await prisma.labOrder.update({ where: { id: labOrderId }, data: { paymentStatus: 'unpaid' } });
  }

  return {
    status: status === 'SUCCESSFUL' ? 'paid' : status === 'FAILED' ? 'unpaid' : 'pending',
    reference: order.paymentReference,
    raw
  };
}

/** Manual override for cash/in-person payment (e.g. paying at the lab's
 * front desk for a home-visit or walk-in sample collection). */
export async function markLabOrderPaid(labOrderId: string, amount: number) {
  return prisma.labOrder.update({
    where: { id: labOrderId },
    data: { paymentStatus: 'paid', paymentAmount: amount }
  });
}

/**
 * Splits a confirmed patient payment: the collection already deposited
 * the full amount into MedVAULT's own Campay wallet, so the platform's
 * cut is simply what's left once the lab's share moves out — same
 * single-transfer design as payment.service.ts's splitPayout, same
 * reasoning (no need to pay ourselves money we already have).
 */
export async function splitLabPayout(labOrderId: string) {
  const order = await prisma.labOrder.findUnique({
    where: { id: labOrderId },
    include: { labProvider: { include: { ownerDoctor: true } } }
  });
  if (!order) throw new Error('lab_order_not_found');
  if (order.paymentStatus !== 'paid') throw new Error('patient_has_not_paid_yet');

  const existingSplit = await prisma.paymentSplit.findFirst({
    where: { labOrderId, status: { not: 'failed' } }
  });
  if (existingSplit?.status === 'completed') {
    return { alreadySplit: true, split: existingSplit };
  }

  const totalAmount = Number(order.paymentAmount ?? 0);
  const platformFeePct = env.platformFeePct;
  const platformAmount = Math.round((totalAmount * platformFeePct) / 100);
  const providerAmount = totalAmount - platformAmount;

  // Lab's own momo first, falling back to the owning doctor's — same
  // fallback pattern as the appointment side falling back to the hospital.
  const providerMomo = order.labProvider.momoNumber ?? order.labProvider.ownerDoctor?.momoNumber;
  const providerNetwork =
    order.labProvider.momoNetwork ?? order.labProvider.ownerDoctor?.momoNetwork ?? 'MTN';

  if (!providerMomo) throw new Error('no_momo_number_found_for_lab_or_owner');

  const split = await prisma.paymentSplit.create({
    data: {
      labOrderId,
      totalAmount,
      platformFeePct,
      platformAmount,
      providerAmount,
      medvaultMomo: env.medvaultMomoNumber || null,
      providerMomo,
      providerNetwork,
      patientPaymentRef: order.paymentReference
    }
  });

  try {
    const providerRes = await campay.transfer(
      providerMomo,
      providerAmount,
      `Lab order payout — ${order.orderRef}`,
      `mv-lab-provider-${order.orderRef}`
    );

    await prisma.paymentSplit.update({
      where: { id: split.id },
      data: {
        providerPayoutRef: providerRes.data.reference ?? null,
        status: providerRes.ok ? 'completed' : 'failed',
        completedAt: providerRes.ok ? new Date() : null
      }
    });

    if (!providerRes.ok) {
      const err: any = new Error('provider_payout_transfer_failed');
      err.provider = providerRes.data;
      throw err;
    }

    return { platformAmount, providerAmount, providerRef: providerRes.data.reference };
  } catch (err) {
    await prisma.paymentSplit.update({ where: { id: split.id }, data: { status: 'failed' } });
    throw err;
  }
}
