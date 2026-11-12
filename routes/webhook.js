const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { 
  sendOrderTemplate, 
  sendOrderShippedTemplate, 
  sendOrderShippedTrackingTemplate,
  sendCodOrderConfirmation,
  sendTextMessage
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

module.exports = router;
