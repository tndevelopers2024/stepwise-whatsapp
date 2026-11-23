const assert = require('assert');
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const assessmentRoutes = require('./routes/assessmentBooking');
const { isBookingProcessed, markBookingProcessed } = require('./services/bookingCache');

console.log('--- Starting Assessment Direct Booking Endpoint Tests ---');

// Clean test bookings cache before tests
const BOOKINGS_CACHE_FILE = path.join(__dirname, 'bookings_cache.json');
if (fs.existsSync(BOOKINGS_CACHE_FILE)) {
  fs.unlinkSync(BOOKINGS_CACHE_FILE);
}

const app = express();
app.use(express.json());
app.use('/api/assessment-booking', assessmentRoutes);

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api/assessment-booking`;

  try {
    // Test 1: GET endpoint info
    console.log('\n[Test 1] Testing GET /api/assessment-booking...');
    const getRes = await axios.get(baseUrl);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.data.status, 'active');
    console.log('✔ GET endpoint info passed!');

    // Test 2: Preflight OPTIONS request & CORS
    console.log('\n[Test 2] Testing OPTIONS preflight request & CORS headers...');
    const optionsRes = await axios({
      method: 'OPTIONS',
      url: baseUrl,
      headers: {
        'Origin': 'https://stepwisehealth.in',
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.strictEqual(optionsRes.status, 204);
    assert.strictEqual(optionsRes.headers['access-control-allow-origin'], '*');
    console.log('✔ CORS preflight OPTIONS passed with Access-Control-Allow-Origin: *');

    // Test 3: Validation - Reject invalid WhatsApp number
    console.log('\n[Test 3] Testing validation of invalid phone number...');
    try {
      await axios.post(baseUrl, {
        bookingRef: '#SW-INVALID',
        patientName: 'Test Patient',
        whatsappNumber: '12345', // too short
        appointmentDate: '28/11/2026',
        timeSlot: '10:00 AM - 01:00 PM',
        amount: '₹1.00',
        paymentId: 'pay_invalid',
        status: 'PAID'
      });
      assert.fail('Should have failed with 400 Bad Request');
    } catch (err) {
      assert.strictEqual(err.response.status, 400);
      assert.strictEqual(err.response.data.success, false);
      console.log('✔ Phone validation: successfully rejected invalid mobile number with 400!');
    }

    // Test 4: Successful Assessment Booking
    console.log('\n[Test 4] Testing valid booking POST request...');
    const payload = {
      bookingRef: '#SW-1058',
      patientName: 'Patient Full Name',
      whatsappNumber: '9876543210',
      appointmentDate: '28/11/2026',
      timeSlot: '10:00 AM - 01:00 PM (Morning)',
      amount: '₹99.00',
      paymentId: 'pay_xxxxxxxxxxxx',
      status: 'PAID',
      timestamp: '2026-11-23T11:42:32.000Z'
    };

    const postRes = await axios.post(baseUrl, payload, {
      headers: {
        'Origin': 'https://stepwisehealth.in'
      }
    });

    assert.strictEqual(postRes.status, 200);
    assert.strictEqual(postRes.data.success, true);
    assert.strictEqual(postRes.data.status, 'confirmed');
    assert.strictEqual(postRes.data.bookingRef, '#SW-1058');
    assert.strictEqual(postRes.data.whatsappNumber, '919876543210'); // sanitized with 91 prefix
    assert.strictEqual(postRes.data.patientName, 'Patient Full Name');
    assert.strictEqual(postRes.data.amount, '₹99');
    assert.ok(postRes.data.timestampIST.includes('IST'));
    assert.strictEqual(postRes.headers['access-control-allow-origin'], '*');
    console.log('✔ Successful booking POST passed! Extracted and sanitized mobile with 91 prefix and ₹99 amount.');

    // Test 5: Deduplication Check
    console.log('\n[Test 5] Testing deduplication of duplicate POST request...');
    const duplicateRes = await axios.post(baseUrl, payload);
    assert.strictEqual(duplicateRes.status, 200);
    assert.strictEqual(duplicateRes.data.success, true);
    assert.strictEqual(duplicateRes.data.status, 'already_processed');
    console.log('✔ Deduplication passed! Ignored duplicate booking submission.');

    // Test 6: Phone sanitization variants (e.g. +91 with spaces, leading 0)
    console.log('\n[Test 6] Testing various phone format sanitization...');
    const payloadVariants = [
      { phone: '+91 9123456789', ref: '#SW-2001', pay: 'pay_2001' },
      { phone: '09123456788', ref: '#SW-2002', pay: 'pay_2002' },
      { phone: '919123456787', ref: '#SW-2003', pay: 'pay_2003' }
    ];

    for (const item of payloadVariants) {
      const res = await axios.post(baseUrl, {
        bookingRef: item.ref,
        patientName: 'Test Sanitization',
        whatsappNumber: item.phone,
        appointmentDate: '29/11/2026',
        timeSlot: '03:00 PM - 07:00 PM',
        amount: '₹99.00',
        paymentId: item.pay,
        status: 'PAID'
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.data.whatsappNumber.startsWith('91'));
      assert.strictEqual(res.data.whatsappNumber.length, 12);
    }
    console.log('✔ Phone sanitization passed for all variants (+91, 0, 91)!');

    console.log('\n==========================================================');
    console.log('🎉 ALL ASSESSMENT DIRECT BOOKING TESTS PASSED! 🎉');
    console.log('==========================================================\n');

  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  } finally {
    server.close();
  }
});
