const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_TEMPLATE_LANG = 'en_US'
} = process.env;

const graphApiUrl = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

const getHeaders = () => ({
  'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
  'Content-Type': 'application/json'
});

const sendOrderTemplate = async (to, customerName, orderNumber, productName, total, imageUrl) => {
  const fallbackImageUrl = 'https://via.placeholder.com/600x400.png?text=Your+Order';
  const headerImageUrl = imageUrl || fallbackImageUrl;

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: process.env.WHATSAPP_TEMPLATE_NAME || 'order_confirmation',
      language: { code: WHATSAPP_TEMPLATE_LANG },
      components: [
        {
          type: 'header',
          parameters: [
            {
              type: 'image',
              image: { link: headerImageUrl }
            }
          ]
        },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'Valued Customer' },
            { type: 'text', text: productName || '' },
            { type: 'text', text: orderNumber || '' },
            { type: 'text', text: total || '' }
          ]
        }
      ]
    }
  };

  try {
    const response = await axios.post(graphApiUrl, payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Error sending sendOrderTemplate:', error.response?.data || error.message);
    throw error;
  }
};

const sendOrderShippedTemplate = async (to, customerName, orderNumber, productName, total) => {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      // Provide appropriate template name for order shipped (fallback using generic if not provided)
      name: process.env.WHATSAPP_SHIPPED_TEMPLATE_NAME || 'order_shipped', 
      language: { code: WHATSAPP_TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'Valued Customer' },
            { type: 'text', text: orderNumber || '' },
            { type: 'text', text: productName || '' },
            { type: 'text', text: total || '' }
          ]
        }
      ]
    }
  };

  try {
    const response = await axios.post(graphApiUrl, payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Error sending sendOrderShippedTemplate:', error.response?.data || error.message);
    throw error;
  }
};

const sendOrderShippedTrackingTemplate = async (to, customerName, orderNumber, productName, carrier, trackingNumber, trackingLink) => {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      // Provide appropriate template name for order tracking
      name: process.env.WHATSAPP_TRACKING_TEMPLATE_NAME || 'order_shipped_tracking_v2', 
      language: { code: WHATSAPP_TEMPLATE_LANG },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: customerName || 'Valued Customer' },
            { type: 'text', text: orderNumber || '' },
            { type: 'text', text: productName || '' },
            { type: 'text', text: carrier || '' },
            { type: 'text', text: trackingNumber || '' },
            { type: 'text', text: trackingLink || '' }
          ]
        }
      ]
    }
  };

  try {
    const response = await axios.post(graphApiUrl, payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Error sending sendOrderShippedTrackingTemplate:', error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  sendOrderTemplate,
  sendOrderShippedTemplate,
  sendOrderShippedTrackingTemplate
};
