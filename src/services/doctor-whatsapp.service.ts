import { prisma } from '../db/prisma.js';
import { sendTextMessage } from './whatsapp.service.js';
import { claimInstantRequest, notifyLosingDoctors } from './teleconsult-request.service.js';
import { logError } from './error-log.service.js';

/**
 * Routes a doctor's ACCEPT/DECLINE button tap to the atomic claim logic
 * and replies to that doctor. This is intentionally NOT part of the BEN
 * conversational agent loop (handleIncomingWhatsAppMessage in
 * ai-agent.service.ts) — a doctor tapping a button isn't a conversation
 * turn that needs an LLM to interpret; the button's own id already says
 * exactly what happened and which request it refers to. Routing it
 * through the agent would also be slower (an extra model call) at
 * exactly the moment speed decides who wins the race.
 */
export async function handleDoctorWhatsAppInteraction(doctorPhone: string, buttonReplyId: string): Promise<void> {
  const [action, requestId] = buttonReplyId.split(':');
  if ((action !== 'accept' && action !== 'decline') || !requestId) return;

  const doctor = await prisma.doctor.findUnique({ where: { phone: doctorPhone } });
  if (!doctor) {
    // Shouldn't happen — only doctors on file ever get dispatched a
    // button in the first place — but a phone number changing hands or
    // a doctor record being edited mid-window is possible, so this stays
    // a quiet no-op rather than a thrown error that would 500 the webhook.
    return;
  }

  if (action === 'decline') {
    await sendTextMessage(doctorPhone, 'Noted, thanks for letting us know.').catch(() => {});
    return;
  }

  try {
    const result = await claimInstantRequest(requestId, doctor.id);
    if (result.outcome === 'won') {
      await sendTextMessage(
        doctorPhone,
        `✅ Consultation accepted.\n\nThe patient has been assigned to you.\nAppointment ref: ${result.appointmentRef}\nOpen your MedVAULT dashboard to start the consultation once payment is confirmed.`
      );
      await notifyLosingDoctors(requestId, doctor.id);
      if (result.patientWaPhoneNumber) {
        if (result.paymentRequested) {
          await sendTextMessage(
            result.patientWaPhoneNumber,
            `A doctor has accepted your teleconsult request!${result.fee ? ` A payment prompt for ${result.fee.toLocaleString()} XAF is on its way to your phone — please approve it to confirm your consultation.` : ''}`
          );
        } else {
          // The automatic payment request itself failed (Campay error,
          // network issue, etc — see the instant_consult_auto_payment_
          // request_failed entry in ErrorLog for the real reason). Found
          // via a real case where the patient was told a prompt was "on
          // its way" that never actually arrived, then had to argue with
          // BEN — who had no memory of any of this — before it finally
          // got escalated. Telling the truth immediately and escalating
          // right here, rather than waiting for the patient to notice
          // and re-explain everything to BEN, is a faster and more
          // honest path to the same outcome.
          await sendTextMessage(
            result.patientWaPhoneNumber,
            `A doctor has accepted your teleconsult request! We hit a hiccup sending the payment prompt automatically — our team has been notified and will reach out to you directly to complete payment.`
          );
          await logError(
            'instant_consult_payment_needs_manual_followup',
            new Error(
              `Appointment ${result.appointmentRef} accepted by doctor but automatic payment request failed. Patient: ${result.patientWaPhoneNumber}, fee: ${result.fee}. Needs manual payment follow-up.`
            )
          );
        }
      }
    } else if (result.outcome === 'already_taken') {
      await sendTextMessage(doctorPhone, '⚠️ Already taken — another doctor accepted first. Thanks for the quick response.');
    } else if (result.outcome === 'expired') {
      await sendTextMessage(doctorPhone, 'This request has expired — the patient was not able to wait any longer.');
    } else {
      await sendTextMessage(doctorPhone, "That request couldn't be found — it may have already been resolved.");
    }
  } catch (err) {
    await logError('doctor_whatsapp_claim_failed', new Error(JSON.stringify({ doctorPhone, requestId, err: String(err) })));
    await sendTextMessage(doctorPhone, 'Something went wrong processing your response — please open the MedVAULT dashboard to check.').catch(() => {});
  }
}
