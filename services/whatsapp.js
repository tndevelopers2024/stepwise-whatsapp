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

const sendCodOrderConfirmation = async (to, customerName, orderNumber, productName, total, orderId, imageUrl) => {
  const effectiveOrderId = orderId || `cod_${Date.now()}`;

  // If a dedicated WhatsApp template is configured for COD, try that first
  if (process.env.WHATSAPP_COD_TEMPLATE_NAME) {
    try {
      const templatePayload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: process.env.WHATSAPP_COD_TEMPLATE_NAME,
          language: { code: WHATSAPP_TEMPLATE_LANG },
          components: [
            ...(imageUrl ? [{
              type: 'header',
              parameters: [{ type: 'image', image: { link: imageUrl } }]
            }] : []),
            {
              type: 'body',
              parameters: [
                { type: 'text', text: customerName || 'Valued Customer' },
                { type: 'text', text: orderNumber || '' },
                { type: 'text', text: productName || 'Your Order' },
                { type: 'text', text: total || '' }
              ]
            },
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: '0',
              parameters: [{ type: 'payload', payload: `cod_confirm_${effectiveOrderId}` }]
            },
            {
              type: 'button',
              sub_type: 'quick_reply',
              index: '1',
              parameters: [{ type: 'payload', payload: `cod_cancel_${effectiveOrderId}` }]
            }
          ]
        }
      };
      const response = await axios.post(graphApiUrl, templatePayload, { headers: getHeaders() });
      return response.data;
    } catch (templateError) {
      console.warn('[WhatsApp] COD template failed or not found, falling back to interactive button message:', templateError.response?.data || templateError.message);
    }
  }

  // WhatsApp Interactive Button Message
  const bodyText = `Hi ${customerName || 'Valued Customer'},\n\nThank you for placing order ${orderNumber} for ${productName || 'your items'}.\n\n*Total:* ${total || ''}\n*Payment Mode:* Cash on Delivery (COD)\n\nPlease click a button below to confirm or cancel your order:`;

  const interactivePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: imageUrl ? {
        type: 'image',
        image: { link: imageUrl }
      } : {
        type: 'text',
        text: 'COD Order Confirmation'
      },
      body: {
        text: bodyText
      },
      footer: {
        text: 'Please select an option'
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: `cod_confirm_${effectiveOrderId}`,
              title: 'Confirm Order'
            }
          },
          {
            type: 'reply',
            reply: {
              id: `cod_cancel_${effectiveOrderId}`,
              title: 'Cancel Order'
            }
          }
        ]
      }
    }
  };

  try {
    const response = await axios.post(graphApiUrl, interactivePayload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    if (imageUrl && error.response?.data?.error) {
      console.warn('[WhatsApp] Failed with image header, retrying with text header...');
      interactivePayload.interactive.header = {
        type: 'text',
        text: 'COD Order Confirmation'
      };
      const retryResponse = await axios.post(graphApiUrl, interactivePayload, { headers: getHeaders() });
      return retryResponse.data;
    }
    console.error('Error sending sendCodOrderConfirmation:', error.response?.data || error.message);
    throw error;
  }
};

const sendTextMessage = async (to, text) => {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text }
  };

  try {
    const response = await axios.post(graphApiUrl, payload, { headers: getHeaders() });
    return response.data;
  } catch (error) {
    console.error('Error sending sendTextMessage:', error.response?.data || error.message);
    throw error;
  }
};

module.exports = {
  sendOrderTemplate,
  sendOrderShippedTemplate,
  sendOrderShippedTrackingTemplate,
  sendCodOrderConfirmation,
  sendTextMessage
};
