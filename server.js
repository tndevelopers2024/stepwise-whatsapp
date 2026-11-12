require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook');
const { 
  sendOrderTemplate, 
  sendCodOrderConfirmation, 
  sendTextMessage 
} = require('./services/whatsapp');
const { exchangeOAuthCode } = require('./services/shopify');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Stylish Splash Page Endpoint (also handles Shopify OAuth callback if ?code=&shop= is present)
app.get('/', async (req, res) => {
  const { code, shop } = req.query;

  if (code && shop) {
    try {
      await exchangeOAuthCode(shop, code);
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head><meta charset="UTF-8"><title>Shopify App Connected</title></head>
        <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #075E54; color: white; text-align: center;">
          <div>
            <h1>✅ Shopify Store Connected!</h1>
            <p>Store <strong>${shop}</strong> has been successfully authorized for WhatsApp COD Automation.</p>
            <p>You can close this tab and return to your Shopify Admin.</p>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      console.error('[Shopify OAuth] Callback error:', err.message);
      return res.status(500).send(`<h1>OAuth Error</h1><p>${err.message}</p>`);
    }
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Stepwise WhatsApp Integration</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          height: 100vh;
          display: flex;
          justify-content: center;
          align-items: center;
          background: linear-gradient(135deg, #128C7E, #075E54, #25D366);
          background-size: 200% 200%;
          animation: gradientShift 10s ease infinite;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          color: white;
          text-align: center;
        }
        .container {
          background: rgba(255, 255, 255, 0.1);
          padding: 4rem 3rem;
          border-radius: 20px;
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.2);
          animation: fadeIn 1.5s ease-in-out;
        }
        h1 {
          margin: 0;
          font-size: 2.5rem;
          font-weight: 700;
          letter-spacing: 1px;
          text-shadow: 0 2px 10px rgba(0,0,0,0.2);
        }
        p {
          margin-top: 1.5rem;
          font-size: 1.2rem;
          font-weight: 300;
          opacity: 0.9;
        }
        .status-dot {
          display: inline-block;
          width: 12px;
          height: 12px;
          background-color: #4ade80;
          border-radius: 50%;
          margin-right: 8px;
          box-shadow: 0 0 10px #4ade80;
          animation: pulse 2s infinite;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); }
          70% { box-shadow: 0 0 0 10px rgba(74, 222, 128, 0); }
          100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
        }
        @keyframes gradientShift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Stepwise WhatsApp Integration Background</h1>
        <p><span class="status-dot"></span> Backend Services Online</p>
        <p style="margin-top: 2rem; font-size: 0.9rem; opacity: 0.7; font-weight: bold; text-transform: uppercase; letter-spacing: 2px;">(Don't delete this)</p>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

// JSON Health Check Endpoint (kept as requested)
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Shopify to WhatsApp Integration Backend is running.' });
});

// Test Endpoint to trigger Meta API directly
app.post('/api/whatsapp/order-confirmation', async (req, res) => {
  const { to, customerName, orderNumber, productName, total, imageUrl } = req.body;
  
  if (!to) {
    return res.status(400).json({ error: 'Missing "to" (phone number) in request body.' });
  }

  try {
    const result = await sendOrderTemplate(to, customerName, orderNumber, productName, total, imageUrl);
    res.status(200).json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test Endpoint to trigger Meta COD Confirmation directly with Confirm/Cancel buttons
app.post('/api/whatsapp/cod-confirmation', async (req, res) => {
  const { to, customerName, orderNumber, productName, total, orderId, imageUrl } = req.body;
  
  if (!to) {
    return res.status(400).json({ error: 'Missing "to" (phone number) in request body.' });
  }

  try {
    const result = await sendCodOrderConfirmation(
      to,
      customerName || 'Valued Customer',
      orderNumber || '#1001',
      productName || 'Test Product',
      total || '₹999.00',
      orderId || `test_${Date.now()}`,
      imageUrl
    );
    res.status(200).json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mount Webhook Routes
app.use('/api/webhooks', webhookRoutes);

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
