const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { 
  sendOrderTemplate, 
  sendOrderShippedTemplate, 
  sendOrderShippedTrackingTemplate,
  sendCodOrderConfirmation,
  sendTextMessage,
  sendBookingConfirmationMessage
} = require('../services/whatsapp');
const {
  markOrderCodPending,
  confirmOrder,
  cancelCodOrder
} = require('../services/shopify');
const {
  savePendingCodOrder,
  findCodOrderById,
  findLatestPendingCodOrderByPhone,
  updateCodOrderStatus,
  loadCodCache
} = require('../services/codCache');
const {
  isBookingProcessed,
  markBookingProcessed,
  loadBookingsCache
} = require('../services/bookingCache');

const router = express.Router();
const TRACKING_CACHE_FILE = path.join(__dirname, '..', 'tracking_cache.json');

// Helper to initialize or load cache
const loadCache = () => {
  if (!fs.existsSync(TRACKING_CACHE_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(TRACKING_CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading cache:', err);
    return [];
  }
};

// Helper to save cache
const saveCache = (cache) => {
  try {
    fs.writeFileSync(TRACKING_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing cache:', err);
  }
};

// Helper to determine if an order is Cash on Delivery (COD)
const isCodOrder = (order) => {
  const customCodGateways = (process.env.COD_GATEWAY_NAMES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const defaultCodKeywords = ['cod', 'cash on delivery', 'cash_on_delivery', 'cash', 'manual'];
  const codKeywords = [...new Set([...defaultCodKeywords, ...customCodGateways])];

  // 1. Check payment_gateway_names array
  const gatewayNames = Array.isArray(order.payment_gateway_names)
    ? order.payment_gateway_names.map(g => String(g).toLowerCase())
    : [];

  const matchedInGatewayNames = gatewayNames.some(name =>
    codKeywords.some(keyword => name.includes(keyword))
  );
  if (matchedInGatewayNames) return true;

  // 2. Check gateway string
  const gateway = (order.gateway || '').toLowerCase();
  if (gateway && codKeywords.some(keyword => gateway.includes(keyword))) {
    return true;
  }

  // 3. Check tags
  const tags = (order.tags || '').toLowerCase();
  if (tags.includes('cod') || tags.includes('cash on delivery')) {
    return true;
  }

  // 4. Check note_attributes
  if (Array.isArray(order.note_attributes)) {
    const isCodAttribute = order.note_attributes.some(attr => {
      const name = (attr.name || '').toLowerCase();
      const val = (attr.value || '').toLowerCase();
      return (name.includes('payment') || name.includes('cod')) && (val.includes('cod') || val.includes('cash'));
    });
    if (isCodAttribute) return true;
  }

  return false;
};

// Helper to check if line item is Foot Health Assessment (handles URL: /products/foot-health-assessment-3d-scan-neuropathy-screening)
const isAssessmentBookingItem = (item) => {
  if (!item) return false;
  const targetHandle = 'foot-health-assessment-3d-scan-neuropathy-screening';
  const handle = String(item.handle || item.product_handle || '').trim().toLowerCase();
  const title = String(item.title || item.name || '').trim().toLowerCase();

  return (
    handle === targetHandle ||
    title.includes('foot health assessment') ||
    title.includes('3d scan')
  );
};

// Common data extraction
const extractCommonData = (order) => {
  // Phone extraction
  let rawPhone = null;
  if (order.shipping_address && order.shipping_address.phone) rawPhone = order.shipping_address.phone;
  else if (order.billing_address && order.billing_address.phone) rawPhone = order.billing_address.phone;
  else if (order.customer && order.customer.phone) rawPhone = order.customer.phone;
  else if (order.phone) rawPhone = order.phone;
  else if (order.customer && order.customer.default_address && order.customer.default_address.phone) rawPhone = order.customer.default_address.phone;

  let formattedPhone = null;
  if (rawPhone) {
    formattedPhone = rawPhone.replace(/\D/g, ''); // Strip non-numeric
    if (formattedPhone.length === 10) {
      formattedPhone = '91' + formattedPhone;
    }
  }

  // Name extraction
  let customerName = 'Valued Customer';
  if (order.shipping_address && (order.shipping_address.first_name || order.shipping_address.last_name)) {
    customerName = `${order.shipping_address.first_name || ''} ${order.shipping_address.last_name || ''}`.trim();
  } else if (order.customer && (order.customer.first_name || order.customer.last_name)) {
    customerName = `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim();
  }

  // Product name extraction
  let productName = 'Your Order';
  if (order.line_items && order.line_items.length > 0) {
    productName = order.line_items[0].name || order.line_items[0].title;
    if (order.line_items.length > 1) {
      productName += ` (+${order.line_items.length - 1} more)`;
    }
  }

  const orderNumber = order.order_number ? `#${order.order_number}` : (order.name || '');
  const total = order.total_price ? `${order.currency} ${order.total_price}` : '';

  return { phone: formattedPhone, customerName, productName, orderNumber, total };
};

// Endpoint 1: POST /orders/create
router.post('/orders/create', async (req, res) => {
  res.sendStatus(200); // Always respond early or at the end. We'll do early to prevent Shopify retries for timeouts.

  const order = req.body;
  const storeDomain = req.headers['x-shopify-shop-domain'];
  
  const { phone, customerName, productName, orderNumber, total } = extractCommonData(order);

  if (!phone) {
    console.warn(`[orders/create] No phone number found for order ${orderNumber}`);
    return;
  }

  // If order is for Foot Health Assessment booking, skip generic ecommerce order template
  // (The dedicated appointment confirmation template will be sent via /shopify/order-paid)
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.some(isAssessmentBookingItem)) {
    console.log(`[orders/create] Order ${orderNumber} is for Foot Health Assessment booking. Skipping generic order template.`);
    return;
  }

  // Check if order is Cash On Delivery (COD)
  const isCod = isCodOrder(order);

  // 1. If COD, save to cache immediately so order is recorded before any external async calls
  if (isCod) {
    savePendingCodOrder({
      orderId: order.id,
      orderNumber,
      phone,
      customerName,
      productName,
      total,
      storeDomain
    });
    console.log(`[orders/create] Detected COD order ${orderNumber} (ID: ${order.id}) for ${customerName}`);
  }

  // Extract Image
  let imageUrl = null;
  const firstItem = order.line_items && order.line_items[0];

  if (firstItem && firstItem.image && firstItem.image.src) {
    imageUrl = firstItem.image.src;
  } else if (firstItem && storeDomain) {
    // Attempt to fetch from Shopify search API
    try {
      const searchUrl = `https://${storeDomain}/search/suggest.json?q=id:${firstItem.product_id}&resources[type]=product`;
      const searchRes = await axios.get(searchUrl);
      const productResults = searchRes.data?.resources?.results?.products;
      
      if (productResults && productResults.length > 0 && productResults[0].image) {
        imageUrl = productResults[0].image;
      } else {
        // Fallback search by title
        const titleSearchUrl = `https://${storeDomain}/search/suggest.json?q=${encodeURIComponent(firstItem.title)}&resources[type]=product`;
        const titleSearchRes = await axios.get(titleSearchUrl);
        const titleResults = titleSearchRes.data?.resources?.results?.products;
        if (titleResults && titleResults.length > 0 && titleResults[0].image) {
          imageUrl = titleResults[0].image;
        }
      }
    } catch (err) {
      console.error(`[orders/create] Error fetching product image fallback:`, err.message);
    }
  }

  if (isCod) {
    // 2. Mark order as COD-Pending in Shopify
    try {
      await markOrderCodPending(order.id, storeDomain);
    } catch (err) {
      console.error(`[orders/create] Failed to mark order ${order.id} as COD-Pending:`, err.message);
    }

    // 3. Send WhatsApp message with Confirm Order and Cancel Order buttons
    try {
      await sendCodOrderConfirmation(phone, customerName, orderNumber, productName, total, order.id, imageUrl);
      console.log(`[orders/create] Sent COD confirmation buttons to ${phone} for ${orderNumber}`);
    } catch (err) {
      console.error(`[orders/create] Failed to send COD confirmation to ${phone}:`, err);
    }
  } else {
    // Non-COD order: preserve existing order confirmation template behavior
    try {
      await sendOrderTemplate(phone, customerName, orderNumber, productName, total, imageUrl);
      console.log(`[orders/create] Sent order confirmation to ${phone} for ${orderNumber}`);
    } catch (err) {
      console.error(`[orders/create] Failed to send to ${phone}`, err);
    }
  }
});

// Endpoint 2: POST /orders/fulfilled
router.post('/orders/fulfilled', async (req, res) => {
  res.sendStatus(200);

  const order = req.body;
  const { phone, customerName, productName, orderNumber, total } = extractCommonData(order);

  if (!phone) {
    console.warn(`[orders/fulfilled] No phone number found for order ${orderNumber}`);
    return;
  }

  // Skip shipping template for Foot Health Assessment bookings
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.some(isAssessmentBookingItem)) {
    console.log(`[orders/fulfilled] Order ${orderNumber} is for Foot Health Assessment booking. Skipping shipping template.`);
    return;
  }

  try {
    await sendOrderShippedTemplate(phone, customerName, orderNumber, productName, total);
    console.log(`[orders/fulfilled] Sent order shipped to ${phone} for ${orderNumber}`);
  } catch (err) {
    console.error(`[orders/fulfilled] Failed to send to ${phone}`, err);
  }
});

// Endpoint 3: POST /orders/updated
router.post('/orders/updated', async (req, res) => {
  res.sendStatus(200);

  const order = req.body;
  const { phone, customerName, productName, orderNumber } = extractCommonData(order);

  if (!phone) {
    console.warn(`[orders/updated] No phone number found for order ${orderNumber}`);
    return;
  }

  // Skip tracking update for Foot Health Assessment bookings
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  if (lineItems.some(isAssessmentBookingItem)) {
    return;
  }

  if (!order.fulfillments || order.fulfillments.length === 0) {
    return; // No fulfillments yet
  }

  const cache = loadCache();
  
  for (const fulfillment of order.fulfillments) {
    if (cache.includes(fulfillment.id)) {
      continue; // Already processed
    }

    const trackingNumber = fulfillment.tracking_number || (fulfillment.tracking_numbers && fulfillment.tracking_numbers[0]);
    const trackingLink = fulfillment.tracking_url || (fulfillment.tracking_urls && fulfillment.tracking_urls[0]);
    const carrier = fulfillment.tracking_company;

    if (trackingNumber && trackingLink) {
      try {
        await sendOrderShippedTrackingTemplate(phone, customerName, orderNumber, productName, carrier, trackingNumber, trackingLink);
        console.log(`[orders/updated] Sent tracking update to ${phone} for ${orderNumber}`);
        
        // Add to cache and save
        cache.push(fulfillment.id);
        saveCache(cache);
        
        break; // Process one new tracking info per webhook to avoid spamming
      } catch (err) {
        console.error(`[orders/updated] Failed to send tracking to ${phone}`, err);
      }
    }
  }
});

// WhatsApp Webhook Verification Endpoint (Meta Challenge)
const handleWhatsAppVerification = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expectedVerifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'stepwise_webhook_verify_token';

  if (mode && token) {
    if (mode === 'subscribe' && token === expectedVerifyToken) {
      console.log('[whatsapp/webhook] Webhook verified successfully by Meta.');
      return res.status(200).send(challenge);
    } else {
      console.warn('[whatsapp/webhook] Webhook verification failed: verify_token mismatch.');
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
};

// WhatsApp Webhook Incoming Events Endpoint (Customer Responses)
const handleWhatsAppIncomingMessage = async (req, res) => {
  // Always respond immediately with 200 OK so Meta does not retry
  res.sendStatus(200);

  const body = req.body;
  if (!body || !body.entry) {
    return;
  }

  try {
    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value;
        if (!value || !value.messages || !Array.isArray(value.messages)) {
          continue; // Delivery receipts, read receipts, or non-message changes
        }

        for (const message of value.messages) {
          const from = message.from; // Customer phone e.g. "919876543210"
          let action = null; // 'confirm' or 'cancel'
          let orderId = null;

          // 1. Check for interactive button click
          if (message.type === 'interactive' && message.interactive) {
            const buttonReply = message.interactive.button_reply;
            if (buttonReply) {
              const buttonId = buttonReply.id || '';
              if (buttonId.startsWith('cod_confirm_')) {
                action = 'confirm';
                orderId = buttonId.replace('cod_confirm_', '');
              } else if (buttonId.startsWith('cod_cancel_')) {
                action = 'cancel';
                orderId = buttonId.replace('cod_cancel_', '');
              }
            }
          }
          // 2. Check for template quick reply button click
          else if (message.type === 'button' && message.button) {
            const payload = message.button.payload || message.button.text || '';
            if (payload.startsWith('cod_confirm_') || payload.toLowerCase().includes('confirm')) {
              action = 'confirm';
              orderId = payload.startsWith('cod_confirm_') ? payload.replace('cod_confirm_', '') : null;
            } else if (payload.startsWith('cod_cancel_') || payload.toLowerCase().includes('cancel')) {
              action = 'cancel';
              orderId = payload.startsWith('cod_cancel_') ? payload.replace('cod_cancel_', '') : null;
            }
          }
          // 3. Check for text message reply (e.g. "Confirm", "Cancel", "Yes", "No")
          else if (message.type === 'text' && message.text) {
            const text = (message.text.body || '').trim().toLowerCase();
            const confirmKeywords = ['confirm', 'confirm order', 'yes', '1', 'ha', 'haa', 'ok', 'accept'];
            const cancelKeywords = ['cancel', 'cancel order', 'no', '2', 'nahi', 'reject'];

            if (confirmKeywords.includes(text)) {
              action = 'confirm';
            } else if (cancelKeywords.includes(text)) {
              action = 'cancel';
            }
          }

          if (!action) {
            continue; // Not a COD action response
          }

          console.log(`[whatsapp/webhook] Customer ${from} selected action: "${action}", orderId: ${orderId || 'searching cache'}`);

          // Resolve order from cache or button ID
          let orderRecord = orderId ? findCodOrderById(orderId) : null;
          if (!orderRecord) {
            orderRecord = findLatestPendingCodOrderByPhone(from);
          }

          const targetOrderId = orderId || (orderRecord && orderRecord.orderId);
          const storeDomain = orderRecord?.storeDomain;
          const customerName = orderRecord?.customerName || 'Valued Customer';
          const orderNumber = orderRecord?.orderNumber || (targetOrderId ? `#${targetOrderId}` : '');
          const productName = orderRecord?.productName || 'Your Order';

          if (!targetOrderId) {
            console.warn(`[whatsapp/webhook] Could not resolve pending order for customer ${from}`);
            await sendTextMessage(
              from,
              `Thank you for reaching out! We couldn't find an active pending COD order for your number. If you need any assistance, our support team is happy to help.`
            );
            continue;
          }

          // Handle Action: CONFIRM
          if (action === 'confirm') {
            if (orderRecord && orderRecord.status === 'confirmed') {
              await sendTextMessage(
                from,
                `Hi ${customerName}, your order *${orderNumber}* is already confirmed! We're processing it for shipment. 🚚`
              );
              continue;
            }

            console.log(`[whatsapp/webhook] Confirming order ${targetOrderId} (${orderNumber}) for ${from}`);

            // Update Shopify Order Status (Tags: COD-Confirmed, Timeline Note)
            try {
              await confirmOrder(targetOrderId, storeDomain);
            } catch (err) {
              console.error(`[whatsapp/webhook] Failed to update Shopify status for order ${targetOrderId}:`, err.message);
            }

            // Update local cache status
            updateCodOrderStatus(targetOrderId, 'confirmed');

            // Send WhatsApp confirmation acknowledgement
            try {
              await sendTextMessage(
                from,
                `✅ *Order Confirmed!*\n\nThank you, ${customerName}! Your COD order *${orderNumber}* for *${productName}* has been confirmed.\n\nWe will pack your items and send you a tracking link as soon as it ships!`
              );
            } catch (err) {
              console.error(`[whatsapp/webhook] Failed to send confirmation message to ${from}:`, err.message);
            }
          }
          // Handle Action: CANCEL
          else if (action === 'cancel') {
            if (orderRecord && orderRecord.status === 'cancelled') {
              await sendTextMessage(
                from,
                `Hi ${customerName}, your order *${orderNumber}* was already cancelled.`
              );
              continue;
            }

            console.log(`[whatsapp/webhook] Cancelling order ${targetOrderId} (${orderNumber}) for ${from}`);

            // Cancel Order in Shopify (API cancel + Tags: COD-Cancelled, Timeline Note)
            try {
              await cancelCodOrder(targetOrderId, storeDomain, 'customer');
            } catch (err) {
              console.error(`[whatsapp/webhook] Failed to cancel Shopify order ${targetOrderId}:`, err.message);
            }

            // Update local cache status
            updateCodOrderStatus(targetOrderId, 'cancelled');

            // Send WhatsApp cancellation acknowledgement
            try {
              await sendTextMessage(
                from,
                `❌ *Order Cancelled*\n\nYour COD order *${orderNumber}* has been successfully cancelled as requested.\n\nIf you changed your mind, feel free to visit our store to place a new order anytime!`
              );
            } catch (err) {
              console.error(`[whatsapp/webhook] Failed to send cancellation message to ${from}:`, err.message);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('[whatsapp/webhook] Error processing incoming webhook:', error);
  }
};

// WhatsApp Webhook Routes
router.get('/whatsapp', handleWhatsAppVerification);
router.post('/whatsapp', handleWhatsAppIncomingMessage);
// Register aliases for /whatsapp/webhook
router.get('/whatsapp/webhook', handleWhatsAppVerification);
router.post('/whatsapp/webhook', handleWhatsAppIncomingMessage);

// Cache inspection endpoint
router.get('/cod-orders', (req, res) => {
  res.status(200).json({ orders: loadCodCache() });
});

// ==========================================
// Foot Health Assessment Booking Integration
// ==========================================

// Helper to extract booking properties from line item properties
const extractBookingProperty = (properties, keys) => {
  if (!properties) return null;

  if (Array.isArray(properties)) {
    for (const key of keys) {
      const prop = properties.find(p => 
        p && typeof p.name === 'string' && p.name.trim().toLowerCase() === key.toLowerCase()
      );
      if (prop && prop.value !== undefined && prop.value !== null && String(prop.value).trim() !== '') {
        return String(prop.value).trim();
      }
    }
  } else if (typeof properties === 'object') {
    for (const key of keys) {
      for (const [propKey, propVal] of Object.entries(properties)) {
        if (propKey.trim().toLowerCase() === key.toLowerCase() && propVal !== undefined && propVal !== null && String(propVal).trim() !== '') {
          return String(propVal).trim();
        }
      }
    }
  }
  return null;
};

// Helper to format India phone number with '91' prefix
const formatIndiaPhone = (rawPhone) => {
  if (!rawPhone) return null;
  let digits = String(rawPhone).replace(/\D/g, '');
  if (digits.length === 10) {
    return '91' + digits;
  }
  if (digits.length === 11 && digits.startsWith('0')) {
    return '91' + digits.slice(1);
  }
  if (digits.length === 12 && digits.startsWith('91')) {
    return digits;
  }
  return digits;
};

// Helper to verify Shopify HMAC SHA256 signature
const verifyShopifyHmac = (req) => {
  const secret = (process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_SIGNING_SECRET || '').trim();
  if (!secret) {
    // Secret not set in .env yet; allow request and log warning
    return true;
  }

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) {
    console.warn('[shopify/order-paid] Missing X-Shopify-Hmac-Sha256 header.');
    return false;
  }

  try {
    const rawBody = req.rawBody ? req.rawBody : Buffer.from(JSON.stringify(req.body));
    const generatedHash = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    return crypto.timingSafeEqual(Buffer.from(generatedHash), Buffer.from(hmacHeader));
  } catch (err) {
    console.error('[shopify/order-paid] HMAC verification error:', err.message);
    return false;
  }
};

// Shopify Order Paid Webhook Handler
const handleShopifyOrderPaid = async (req, res) => {
  // 1. HMAC Verification
  if (!verifyShopifyHmac(req)) {
    console.warn('[shopify/order-paid] HMAC signature verification failed. Rejecting request.');
    return res.status(401).send('Unauthorized: Invalid HMAC signature');
  }

  const order = req.body;
  if (!order || !order.id) {
    return res.status(400).send('Bad Request: Missing order payload');
  }

  const orderId = String(order.id);
  const orderNumber = order.name || (order.order_number ? `#${order.order_number}` : `#${orderId}`);

  // 2. Deduplication check
  if (isBookingProcessed(orderId)) {
    console.log(`[shopify/order-paid] Order ${orderNumber} (${orderId}) already processed. Skipping duplicate webhook.`);
    return res.status(200).json({ status: 'ignored', message: 'Order already processed' });
  }

  // 3. Product Filter: Only trigger for Assessment bookings
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
  const assessmentItem = lineItems.find(isAssessmentBookingItem);

  if (!assessmentItem) {
    console.log(`[shopify/order-paid] Order ${orderNumber} does not contain Foot Health Assessment booking. Ignored.`);
    return res.status(200).json({ status: 'ignored', message: 'No assessment product in order' });
  }

  console.log(`[shopify/order-paid] Found Foot Health Assessment booking in order ${orderNumber} (${orderId})`);

  // 4. Extract Custom Booking Properties
  const properties = assessmentItem.properties || [];

  // Patient Name
  let patientName = extractBookingProperty(properties, [
    'Patient Name', 
    'Patient', 
    'Full Name', 
    'Name', 
    'patient_name',
    'patient'
  ]);
  if (!patientName) {
    const customer = order.customer || {};
    const fullName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    patientName = fullName || order.shipping_address?.name || order.billing_address?.name || 'Valued Patient';
  }

  // WhatsApp Number
  let rawPhone = extractBookingProperty(properties, [
    'WhatsApp Number', 
    'WhatsApp', 
    'Mobile Number', 
    'Mobile', 
    'Phone Number', 
    'Phone',
    'whatsapp_number',
    'phone_number'
  ]);
  if (!rawPhone) {
    rawPhone = order.customer?.phone || 
      order.shipping_address?.phone || 
      order.billing_address?.phone || 
      order.phone || 
      (order.customer?.default_address && order.customer.default_address.phone);
  }
  const formattedPhone = formatIndiaPhone(rawPhone);

  // Appointment Date
  const appointmentDate = extractBookingProperty(properties, [
    'Appointment Date', 
    'Date', 
    'Booking Date', 
    'appointment_date',
    'booking_date'
  ]) || 'Scheduled Date';

  // Time Slot
  const timeSlot = extractBookingProperty(properties, [
    'Time Slot', 
    'Slot', 
    'Time', 
    'Session Time', 
    'time_slot',
    'booking_time'
  ]) || 'Scheduled Time';

  // Amount Paid
  const rawAmount = order.current_total_price || order.total_price || assessmentItem.price || '99';
  const cleanAmount = String(rawAmount).replace(/^(INR|₹)\s*/i, '').trim();

  // Mark as processed immediately in deduplication cache
  markBookingProcessed(orderId, {
    orderNumber,
    phone: formattedPhone,
    patientName,
    appointmentDate,
    timeSlot,
    amount: cleanAmount
  });

  // Send 200 response to Shopify
  res.status(200).json({ 
    success: true, 
    orderId, 
    orderNumber,
    patientName,
    phone: formattedPhone
  });

  if (!formattedPhone) {
    console.warn(`[shopify/order-paid] No phone number found for booking in order ${orderNumber}`);
    return;
  }

  // 5. Send WhatsApp Booking Confirmation Message
  try {
    await sendBookingConfirmationMessage({
      to: formattedPhone,
      patientName,
      orderId: orderNumber,
      appointmentDate,
      timeSlot,
      amount: cleanAmount
    });
    console.log(`[shopify/order-paid] Successfully sent booking confirmation to ${formattedPhone} for ${orderNumber}`);
  } catch (err) {
    console.error(`[shopify/order-paid] Failed to send booking confirmation to ${formattedPhone}:`, err.message);
  }
};

// Mount Booking Webhook Endpoints
router.post('/shopify/order-paid', handleShopifyOrderPaid);
router.post('/orders/paid', handleShopifyOrderPaid); // Alias
router.get('/bookings', (req, res) => {
  res.status(200).json({ bookings: loadBookingsCache() });
});

module.exports = router;
