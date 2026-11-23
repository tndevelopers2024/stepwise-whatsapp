const express = require('express');
const { 
  sendBookingConfirmationMessage, 
  sendClinicAlert 
} = require('../services/whatsapp');
const { 
  isBookingProcessed, 
  markBookingProcessed 
} = require('../services/bookingCache');

const router = express.Router();

/**
 * Helper to sanitize Indian mobile numbers to 91XXXXXXXXXX format
 */
const sanitizeIndiaPhone = (rawPhone) => {
  if (!rawPhone) return null;
  const digits = String(rawPhone).replace(/\D/g, '');
  
  if (digits.length === 10) {
    return '91' + digits;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return '91' + digits.slice(1);
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits;
  }
  if (digits.length > 10) {
    return digits;
  }
  return null;
};

/**
 * Helper to format timestamp to Indian Standard Time (IST)
 */
const formatToIST = (timestamp) => {
  try {
    const d = timestamp ? new Date(timestamp) : new Date();
    if (isNaN(d.getTime())) {
      return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    }
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }) + ' IST';
  } catch (err) {
    return String(timestamp || '');
  }
};

// Enable CORS explicitly for all origins including https://stepwisehealth.in
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// GET /api/assessment-booking (Informational check)
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'active',
    endpoint: '/api/assessment-booking',
    method: 'POST',
    description: 'StepWise Health Foot Assessment Direct Booking API',
    supportedFields: [
      'bookingRef',
      'patientName',
      'whatsappNumber',
      'appointmentDate',
      'timeSlot',
      'amount',
      'paymentId',
      'status',
      'timestamp'
    ]
  });
});

// POST /api/assessment-booking (Main booking endpoint)
router.post('/', async (req, res) => {
  const body = req.body || {};

  // Extract fields with flexible fallbacks
  const bookingRef = String(body.bookingRef || body.orderId || body.orderNumber || `#SW-${Date.now().toString().slice(-4)}`).trim();
  const patientName = String(body.patientName || body.name || 'Valued Patient').trim();
  const rawPhone = body.whatsappNumber || body.phone || body.mobile;
  const appointmentDate = String(body.appointmentDate || body.date || 'Scheduled Date').trim();
  const timeSlot = String(body.timeSlot || body.slot || body.time || 'Scheduled Time').trim();
  const rawAmount = body.amount || body.total || '₹99';
  const cleanAmount = String(rawAmount).replace(/^(INR|₹|\s)+/i, '').replace(/\.00$/, '').trim() || '99';
  const paymentId = String(body.paymentId || body.razorpay_payment_id || body.transactionId || '').trim();
  const status = String(body.status || 'PAID').toUpperCase().trim();
  const timestampIST = formatToIST(body.timestamp);

  console.log(`[assessment-booking] Received booking ${bookingRef} for "${patientName}" (Phone: ${rawPhone}, Amount: ${cleanAmount}, Payment: ${paymentId})`);

  // 1. Sanitize & Validate Phone Number
  const sanitizedPhone = sanitizeIndiaPhone(rawPhone);
  if (!sanitizedPhone) {
    console.warn(`[assessment-booking] Rejected booking ${bookingRef}: invalid WhatsApp number "${rawPhone}"`);
    return res.status(400).json({
      success: false,
      error: 'Invalid or missing whatsappNumber. Must be a valid 10-digit Indian mobile number.'
    });
  }

  // 2. Deduplication check (prevents duplicate WhatsApp messages on network retries)
  if (isBookingProcessed(bookingRef, paymentId)) {
    console.log(`[assessment-booking] Duplicate booking detected for ${bookingRef} (${paymentId}). Skipping.`);
    return res.status(200).json({
      success: true,
      status: 'already_processed',
      message: 'Booking has already been confirmed and processed previously.',
      bookingRef,
      paymentId
    });
  }

  // 3. Save to deduplication cache immediately
  markBookingProcessed(bookingRef, {
    bookingRef,
    orderNumber: bookingRef,
    paymentId,
    phone: sanitizedPhone,
    patientName,
    appointmentDate,
    timeSlot,
    amount: cleanAmount,
    status
  });

  // 4. Send Confirmation Message to Patient via WhatsApp
  let patientMessageSent = false;
  try {
    await sendBookingConfirmationMessage({
      to: sanitizedPhone,
      patientName,
      orderId: bookingRef,
      appointmentDate,
      timeSlot,
      amount: cleanAmount,
      paymentId,
      status,
      includeFootwearAdvice: true
    });
    patientMessageSent = true;
    console.log(`[assessment-booking] Successfully dispatched WhatsApp confirmation to patient +${sanitizedPhone} for ${bookingRef}`);
  } catch (err) {
    console.error(`[assessment-booking] Error sending WhatsApp message to patient +${sanitizedPhone}:`, err.message);
  }

  // 5. Send Alert Message to Clinic Staff (Optional)
  try {
    const clinicPhone = process.env.STEPWISE_CLINIC_PHONE || '9894399107';
    await sendClinicAlert({
      clinicPhone,
      bookingRef,
      patientName,
      whatsappNumber: sanitizedPhone,
      appointmentDate,
      timeSlot,
      amount: `₹${cleanAmount}`,
      paymentId,
      status,
      timestampIST
    });
  } catch (alertErr) {
    console.warn(`[assessment-booking] Non-critical warning: Clinic staff alert could not be sent:`, alertErr.message);
  }

  // 6. Return response to frontend
  return res.status(200).json({
    success: true,
    status: 'confirmed',
    message: patientMessageSent 
      ? 'Booking confirmed and WhatsApp message sent successfully.' 
      : 'Booking recorded; WhatsApp notification initiated.',
    bookingRef,
    patientName,
    whatsappNumber: sanitizedPhone,
    appointmentDate,
    timeSlot,
    amount: `₹${cleanAmount}`,
    paymentId,
    timestampIST
  });
});

module.exports = router;
