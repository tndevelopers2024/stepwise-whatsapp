const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { 
  sendOrderTemplate, 
  sendOrderShippedTemplate, 
  sendOrderShippedTrackingTemplate 
} = require('../services/whatsapp');

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

  try {
    await sendOrderTemplate(phone, customerName, orderNumber, productName, total, imageUrl);
    console.log(`[orders/create] Sent order confirmation to ${phone} for ${orderNumber}`);
  } catch (err) {
    console.error(`[orders/create] Failed to send to ${phone}`, err);
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

module.exports = router;
