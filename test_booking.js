const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const {
  isBookingProcessed,
  markBookingProcessed,
  loadBookingsCache
} = require('./services/bookingCache');

console.log('--- Starting Foot Health Assessment Booking Tests ---');

// Clean test bookings cache before tests
const BOOKINGS_CACHE_FILE = path.join(__dirname, 'bookings_cache.json');
if (fs.existsSync(BOOKINGS_CACHE_FILE)) {
  fs.unlinkSync(BOOKINGS_CACHE_FILE);
}

// Test 1: Booking Cache operations
console.log('\n[Test 1] Testing Booking Cache operations...');
assert.strictEqual(isBookingProcessed('999111'), false);
markBookingProcessed('999111', {
  orderNumber: '#1057',
  phone: '919876543210',
  patientName: 'Karthik Raja',
  appointmentDate: '25/11/2026',
  timeSlot: '10:00 AM - 01:00 PM (Morning)',
  amount: '99'
});
assert.strictEqual(isBookingProcessed('999111'), true);
console.log('✔ Booking Cache operations passed!');

// Test 2: Webhook Endpoint Integration Tests
console.log('\n[Test 2] Testing Webhook Endpoint Integration...');

const TEST_SECRET = 'test_shopify_signing_secret_12345';
process.env.SHOPIFY_WEBHOOK_SECRET = TEST_SECRET;

const webhookRoutes = require('./routes/webhook');
const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use('/api/webhooks', webhookRoutes);

const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const generateHmac = (payloadStr, secret) => {
    return crypto.createHmac('sha256', secret).update(payloadStr).digest('base64');
  };

  try {
    // 2a. HMAC Validation - Reject invalid signature
    const samplePayload = {
      id: 888111,
      name: '#1057',
      current_total_price: '99.00',
      line_items: [
        {
          title: 'Foot Health Assessment (3D Scan + Neuropathy Screening)',
          handle: 'foot-health-assessment-3d-scan-neuropathy-screening',
          properties: [
            { name: 'Patient Name', value: 'Sundar Pichai' },
            { name: 'WhatsApp Number', value: '9876543210' },
            { name: 'Appointment Date', value: '25/11/2026' },
            { name: 'Time Slot', value: '10:00 AM - 01:00 PM (Morning)' }
          ]
        }
      ]
    };
    const bodyStr = JSON.stringify(samplePayload);

    try {
      await axios.post(`${baseUrl}/api/webhooks/shopify/order-paid`, samplePayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Hmac-Sha256': 'invalid_signature_here'
        }
      });
      assert.fail('Should have failed with 401 Unauthorized');
    } catch (err) {
      assert.strictEqual(err.response.status, 401);
      console.log('✔ HMAC verification: correctly rejected invalid signature with 401!');
    }

    // 2b. HMAC Validation - Accept valid signature & Process Assessment Booking
    const validHmac = generateHmac(bodyStr, TEST_SECRET);
    const validRes = await axios.post(`${baseUrl}/api/webhooks/shopify/order-paid`, samplePayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': validHmac
      }
    });

    assert.strictEqual(validRes.status, 200);
    assert.strictEqual(validRes.data.success, true);
    assert.strictEqual(validRes.data.patientName, 'Sundar Pichai');
    assert.strictEqual(validRes.data.phone, '919876543210');
    console.log('✔ Valid HMAC & Assessment booking processing passed! Extracted Patient Name and 91 formatted phone.');

    await new Promise(r => setTimeout(r, 100));

    // 2c. Deduplication Test - Send same order again
    const dupeRes = await axios.post(`${baseUrl}/api/webhooks/shopify/order-paid`, samplePayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': validHmac
      }
    });
    assert.strictEqual(dupeRes.status, 200);
    assert.strictEqual(dupeRes.data.status, 'ignored');
    assert.strictEqual(dupeRes.data.message, 'Order already processed');
    console.log('✔ Deduplication passed! Ignored duplicate webhook delivery.');

    // 2d. Product Filter Test - Order with unrelated product (e.g. Shoes)
    const shoeOrderPayload = {
      id: 888222,
      name: '#1058',
      current_total_price: '2499.00',
      line_items: [
        {
          title: 'Stepwise Belleza White',
          handle: 'stepwise-belleza-white',
          price: '2499.00'
        }
      ]
    };
    const shoeBodyStr = JSON.stringify(shoeOrderPayload);
    const shoeHmac = generateHmac(shoeBodyStr, TEST_SECRET);

    const shoeRes = await axios.post(`${baseUrl}/api/webhooks/shopify/order-paid`, shoeOrderPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': shoeHmac
      }
    });
    assert.strictEqual(shoeRes.status, 200);
    assert.strictEqual(shoeRes.data.status, 'ignored');
    assert.strictEqual(shoeRes.data.message, 'No assessment product in order');
    console.log('✔ Product Filter passed! Correctly ignored non-assessment product.');

    // 2e. Fallback Test - Assessment order without custom properties (fallbacks to customer details)
    const fallbackPayload = {
      id: 888333,
      name: '#1059',
      current_total_price: '99.00',
      customer: {
        first_name: 'Ananya',
        last_name: 'Rao',
        phone: '+91 9988776655'
      },
      line_items: [
        {
          title: 'Foot Health Assessment',
          handle: 'foot-health-assessment-3d-scan-neuropathy-screening'
        }
      ]
    };
    const fallbackBodyStr = JSON.stringify(fallbackPayload);
    const fallbackHmac = generateHmac(fallbackBodyStr, TEST_SECRET);

    const fallbackRes = await axios.post(`${baseUrl}/api/webhooks/shopify/order-paid`, fallbackPayload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': fallbackHmac
      }
    });
    assert.strictEqual(fallbackRes.status, 200);
    assert.strictEqual(fallbackRes.data.patientName, 'Ananya Rao');
    assert.strictEqual(fallbackRes.data.phone, '919988776655');
    console.log('✔ Fallback customer details extraction passed!');

    console.log('\n======================================================');
    console.log('🎉 ALL FOOT HEALTH ASSESSMENT TESTS PASSED! 🎉');
    console.log('======================================================\n');
  } catch (err) {
    console.error('Test error:', err);
    process.exitCode = 1;
  } finally {
    server.close();
    // Clean cache file after test
    if (fs.existsSync(BOOKINGS_CACHE_FILE)) {
      fs.unlinkSync(BOOKINGS_CACHE_FILE);
    }
  }
});
