import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { generateRef } from '../services/id.service.js';
import * as campay from '../services/campay.service.js';

export const packagesRouter = Router();

// ── Public — offers list, used by both the homepage and the WhatsApp agent ──
packagesRouter.get(
  '/offers',
  asyncHandler(async (req, res) => {
    const offers = await prisma.packageOffer.findMany({ where: { isActive: true } });
    res.json({
      success: true,
      offers: offers.map((o: any) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        included_items: o.includedItems,
        base_price: Number(o.basePrice),
        home_service_fee: Number(o.homeServiceFee),
        max_child_age: o.maxChildAge
      }))
    });
  })
);

// ── Public — create a booking. Deliberately lead-capture, not a real-time
// slot booking against a specific doctor/hospital — see schema.prisma's
// comment on PackageBooking for why. Total price is computed server-side,
// never trusted from the client/model, same discipline as every other
// price in this system. ──
packagesRouter.post(
  '/bookings',
  asyncHandler(async (req, res) => {
    const {
      offer_id,
      guardian_name,
      guardian_phone,
      city,
      children_ages,
      home_service,
      preferred_date,
      preferred_time_range
    } = req.body;

    if (!offer_id || !guardian_phone || !city || !Array.isArray(children_ages) || children_ages.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'offer_id, guardian_phone, city, and a non-empty children_ages array are required'
      });
    }

    const offer = await prisma.packageOffer.findUnique({ where: { id: offer_id } });
    if (!offer || !offer.isActive) {
      return res.status(404).json({ success: false, error: 'offer_not_found_or_inactive' });
    }

    const tooOld = (children_ages as number[]).filter((age) => age > offer.maxChildAge);
    if (tooOld.length > 0) {
      return res.status(400).json({
        success: false,
        error: `child_age_exceeds_maximum`,
        max_child_age: offer.maxChildAge
      });
    }

    // Price computed server-side — the model/client only ever sends
    // inputs (how many children, whether home service), never the price
    // itself, exactly the same discipline used for every other price in
    // this system.
    const basePrice = Number(offer.basePrice);
    const homeServiceFee = home_service ? Number(offer.homeServiceFee) : 0;
    const totalPrice = basePrice * children_ages.length + homeServiceFee;

    const booking = await prisma.packageBooking.create({
      data: {
        bookingRef: generateRef('MVP'),
        offerId: offer.id,
        guardianName: guardian_name ?? null,
        guardianPhone: guardian_phone,
        city,
        childrenCount: children_ages.length,
        childrenAges: children_ages,
        homeService: !!home_service,
        preferredDate: preferred_date ? new Date(preferred_date) : null,
        preferredTimeRange: preferred_time_range ?? null,
        totalPrice
      }
    });

    res.status(201).json({
      success: true,
      booking_ref: booking.bookingRef,
      total_price: totalPrice
    });
  })
);

// ── Public — request payment for an existing booking. Separate step from
// creation, matching the pattern used for appointments/lab orders — the
// booking exists first, payment is requested against it once confirmed. ──
packagesRouter.post(
  '/bookings/:bookingRef/payment',
  asyncHandler(async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone is required' });

    const booking = await prisma.packageBooking.findUnique({ where: { bookingRef: req.params.bookingRef } });
    if (!booking) return res.status(404).json({ success: false, error: 'booking_not_found' });
    if (booking.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, error: 'already_paid' });
    }

    const cleanPhone = campay.normalizeCameroonPhone(phone);
    const data = await campay.collect(
      cleanPhone,
      Number(booking.totalPrice),
      `MedVAULT ${booking.bookingRef}`,
      `mv-pkg-${booking.bookingRef}`
    );

    await prisma.packageBooking.update({
      where: { id: booking.id },
      data: { paymentReference: data.reference }
    });

    res.json({ success: true, reference: data.reference });
  })
);

// ── Public — track a booking by its own reference. Deliberately no auth:
// the bookingRef itself (long, random, unguessable) acts as the access
// token, same pattern as many order-tracking pages elsewhere. ──
packagesRouter.get(
  '/bookings/:bookingRef',
  asyncHandler(async (req, res) => {
    const booking = await prisma.packageBooking.findUnique({
      where: { bookingRef: req.params.bookingRef },
      include: { offer: true }
    });
    if (!booking) return res.status(404).json({ success: false, error: 'booking_not_found' });

    res.json({
      success: true,
      booking_ref: booking.bookingRef,
      offer_name: booking.offer.name,
      status: booking.status,
      payment_status: booking.paymentStatus,
      total_price: Number(booking.totalPrice),
      city: booking.city,
      children_count: booking.childrenCount,
      home_service: booking.homeService,
      preferred_date: booking.preferredDate,
      preferred_time_range: booking.preferredTimeRange,
      created_at: booking.createdAt
    });
  })
);

// ── Admin — move a booking through its fulfillment statuses ──
packagesRouter.post(
  '/bookings/:bookingRef/status',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const validStatuses = ['pending_payment', 'paid', 'scheduled', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'invalid_status', valid_statuses: validStatuses });
    }
    const booking = await prisma.packageBooking.update({
      where: { bookingRef: req.params.bookingRef },
      data: { status }
    });
    res.json({ success: true, booking });
  })
);

// ── Admin — manage offers ──
packagesRouter.post(
  '/offers',
  requireAuth('admin'),
  asyncHandler(async (req, res) => {
    const { name, description, included_items, base_price, home_service_fee, max_child_age } = req.body;
    if (!name || !base_price) {
      return res.status(400).json({ success: false, error: 'name and base_price are required' });
    }
    const offer = await prisma.packageOffer.create({
      data: {
        name,
        description: description ?? null,
        includedItems: included_items ?? [],
        basePrice: base_price,
        homeServiceFee: home_service_fee ?? 4500,
        maxChildAge: max_child_age ?? 17
      }
    });
    res.status(201).json({ success: true, offer });
  })
);
