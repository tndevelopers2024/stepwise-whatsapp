require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webhookRoutes = require('./routes/webhook');
const { sendOrderTemplate } = require('./services/whatsapp');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/', (req, res) => {
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

// Mount Webhook Routes
app.use('/api/webhooks', webhookRoutes);

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
