import { prisma } from '../db/prisma.js';
import { generateRef } from './id.service.js';
import { queueNotification } from './notification.service.js';

export interface CreateLabOrderInput {
  globalPatientId?: string;
  hospitalId?: string;
  referringDoctorId?: string;
  referralAppointmentId?: string;
  labProviderId: string;
  serviceType: 'home_visit' | 'on_site' | 'both';
  homeAddress?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  labServiceIds: string[];
  source: string;
}

/**
 * Shared by the HTTP route (routes/lab-orders.routes.ts) and the WhatsApp AI
 * agent — same reasoning as appointment.service.ts.
 */
export async function createLabOrder(input: CreateLabOrderInput) {
  const services = await prisma.labService.findMany({
    where: { id: { in: input.labServiceIds }, labProviderId: input.labProviderId, isActive: true }
  });
  if (services.length !== input.labServiceIds.length) {
    throw new Error('one_or_more_lab_services_not_found_or_inactive');
  }

  const labProvider = await prisma.labProvider.findUnique({ where: { id: input.labProviderId } });
  if (!labProvider) throw new Error('lab_provider_not_found');

  const servicesCost = services.reduce((sum: number, s: any) => sum + Number(s.basePrice), 0);
  const homeFee =
    input.serviceType !== 'on_site' ? Number(labProvider.homeServiceFee ?? 0) : 0;
  const totalCost = servicesCost + homeFee;

  const order = await prisma.$transaction(async (tx: any) => {
    const created = await tx.labOrder.create({
      data: {
        orderRef: generateRef('MVL'),
        globalPatientId: input.globalPatientId,
        hospitalId: input.hospitalId,
        referringDoctorId: input.referringDoctorId,
        referralAppointmentId: input.referralAppointmentId,
        labProviderId: input.labProviderId,
        serviceType: input.serviceType,
        homeAddress: input.homeAddress,
        scheduledDate: input.scheduledDate ? new Date(input.scheduledDate) : undefined,
        scheduledTime: input.scheduledTime,
        totalCost,
        source: input.source
      }
    });

    await tx.labOrderItem.createMany({
      data: services.map((s: any) => ({
        labOrderId: created.id,
        labServiceId: s.id,
        priceAtOrder: s.basePrice
      }))
    });

    return created;
  });

  return prisma.labOrder.findUnique({
    where: { id: order.id },
    include: { items: { include: { labService: true } }, labProvider: true }
  });
}

export async function getLabOrder(id: string) {
  return prisma.labOrder.findUnique({
    where: { id },
    include: { items: { include: { labService: true } }, labProvider: true }
  });
}

export async function updateLabOrderStatus(
  id: string,
  update: { status: string; resultPayload?: unknown }
) {
  const order = await prisma.labOrder.update({
    where: { id },
    data: {
      status: update.status as any,
      resultPayload: update.resultPayload as any
    }
  });

  if (update.status === 'completed' && order.globalPatientId) {
    await queueNotification({
      channel: 'whatsapp',
      recipientType: 'patient',
      recipientRef: order.globalPatientId,
      templateType: 'lab_result_ready',
      payload: { params: [order.orderRef] }
    });
  }

  return order;
}

export async function listPendingLabOrdersForHospital(hospitalId: string) {
  return prisma.labOrder.findMany({
    where: { hospitalId, status: { in: ['requested', 'scheduled'] } },
    orderBy: { createdAt: 'asc' }
  });
}
