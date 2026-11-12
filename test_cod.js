const assert = require('assert');
const { 
  savePendingCodOrder, 
  findCodOrderById, 
  findLatestPendingCodOrderByPhone, 
  updateCodOrderStatus,
  loadCodCache
} = require('./services/codCache');
const { 
  getShopifyConfig, 
  isConfigured, 
  markOrderCodPending, 
  confirmOrder, 
  cancelCodOrder 
} = require('./services/shopify');

console.log('--- Starting COD Order Tests ---');

// Test 1: Cache functionality
console.log('\n[Test 1] Testing COD Cache operations...');
const testOrder = {
  orderId: '999888777',
  orderNumber: '#999888',
  phone: '919876543210',
  customerName: 'Test Customer',
  productName: 'Cool T-Shirt',
  total: '₹1299.00',
  storeDomain: 'test-store.myshopify.com'
};

const saved = savePendingCodOrder(testOrder);
assert.strictEqual(saved.orderId, '999888777');
assert.strictEqual(saved.status, 'pending');

const foundById = findCodOrderById('999888777');
assert.ok(foundById);
assert.strictEqual(foundById.orderNumber, '#999888');

const foundByPhone = findLatestPendingCodOrderByPhone('9876543210');
assert.ok(foundByPhone);
assert.strictEqual(foundByPhone.orderId, '999888777');

updateCodOrderStatus('999888777', 'confirmed');
const updatedOrder = findCodOrderById('999888777');
assert.strictEqual(updatedOrder.status, 'confirmed');

console.log('✔ COD Cache operations passed!');

// Test 2: Shopify Service Simulation & Config
console.log('\n[Test 2] Testing Shopify Service methods...');
const config = getShopifyConfig();
console.log('Shopify configured:', isConfigured());

(async () => {
  const pendingRes = await markOrderCodPending('999888777', 'test-store.myshopify.com');
  assert.ok(pendingRes.success);

  const confirmRes = await confirmOrder('999888777', 'test-store.myshopify.com');
  assert.ok(confirmRes.success);

  const cancelRes = await cancelCodOrder('999888777', 'test-store.myshopify.com');
  assert.ok(cancelRes.success);

  console.log('✔ Shopify Service simulated methods passed!');

  // Test 3: Testing Express Endpoints
  console.log('\n[Test 3] Testing Express Webhook endpoints...');
  const express = require('express');
  const webhookRoutes = require('./routes/webhook');
  const app = express();
  app.use(express.json());
  app.use('/api/webhooks', webhookRoutes);

  const server = app.listen(0, async () => {
    const port = server.address().port;
    const axios = require('axios');
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 3a. WhatsApp Webhook Verification GET
      const verifyRes = await axios.get(`${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=stepwise_webhook_verify_token&hub.challenge=test_challenge_12345`);
      assert.strictEqual(verifyRes.status, 200);
      assert.strictEqual(String(verifyRes.data), 'test_challenge_12345');
      console.log('✔ WhatsApp webhook GET verification passed!');

      // 3b. Verify rejection on bad token
      try {
        await axios.get(`${baseUrl}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test_challenge_12345`);
        assert.fail('Should have failed with 403');
      } catch (err) {
        assert.strictEqual(err.response.status, 403);
        console.log('✔ WhatsApp webhook GET rejection on invalid token passed!');
      }

      // 3c. Order Creation Webhook POST with COD order
      const orderPayload = {
        id: 777111222,
        order_number: 1055,
        name: '#1055',
        currency: 'INR',
        total_price: '1499.00',
        gateway: 'cash_on_delivery',
        payment_gateway_names: ['Cash on Delivery (COD)'],
        shipping_address: {
          first_name: 'Rahul',
          last_name: 'Sharma',
          phone: '+919988776655'
        },
        line_items: [
          { title: 'Premium Sneakers', name: 'Premium Sneakers' }
        ]
      };

      const orderCreateRes = await axios.post(`${baseUrl}/api/webhooks/orders/create`, orderPayload, {
        headers: { 'x-shopify-shop-domain': 'test-shop.myshopify.com' }
      });
      assert.strictEqual(orderCreateRes.status, 200);

      // Brief pause to allow background processing
      await new Promise(r => setTimeout(r, 200));

      // Verify order is now cached as pending
      const cachedOrder = findCodOrderById('777111222');
      assert.ok(cachedOrder);
      assert.strictEqual(cachedOrder.orderNumber, '#1055');
      assert.strictEqual(cachedOrder.status, 'pending');
      console.log('✔ Shopify COD order creation webhook passed! Order cached as pending.');

      // 3d. WhatsApp Customer response POST: Button Click "Confirm Order"
      const buttonClickPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '1234567890', phone_number_id: '1104066206126403' },
                  contacts: [{ profile: { name: 'Rahul Sharma' }, wa_id: '919988776655' }],
                  messages: [
                    {
                      from: '919988776655',
                      id: 'wamid.test_button_confirm',
                      timestamp: '1690000000',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: 'cod_confirm_777111222',
                          title: 'Confirm Order'
                        }
                      }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const buttonRes = await axios.post(`${baseUrl}/api/webhooks/whatsapp`, buttonClickPayload);
      assert.strictEqual(buttonRes.status, 200);

      await new Promise(r => setTimeout(r, 200));

      // Verify order status updated to confirmed in cache
      const confirmedOrder = findCodOrderById('777111222');
      assert.strictEqual(confirmedOrder.status, 'confirmed');
      console.log('✔ WhatsApp button click "Confirm Order" passed! Order status updated to confirmed.');

      // 3e. Test another COD order for cancellation
      const cancelOrderPayload = {
        id: 777111333,
        order_number: 1056,
        name: '#1056',
        currency: 'INR',
        total_price: '899.00',
        gateway: 'manual',
        payment_gateway_names: ['COD'],
        shipping_address: {
          first_name: 'Priya',
          last_name: 'Patel',
          phone: '919123456789'
        },
        line_items: [
          { title: 'Handbag' }
        ]
      };

      await axios.post(`${baseUrl}/api/webhooks/orders/create`, cancelOrderPayload);
      await new Promise(r => setTimeout(r, 200));
      const cachedCancelOrder = findCodOrderById('777111333');
      assert.ok(cachedCancelOrder);
      assert.strictEqual(cachedCancelOrder.status, 'pending');

      // WhatsApp Customer response POST: Button Click "Cancel Order"
      const buttonCancelPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  messages: [
                    {
                      from: '919123456789',
                      id: 'wamid.test_button_cancel',
                      timestamp: '1690000001',
                      type: 'interactive',
                      interactive: {
                        type: 'button_reply',
                        button_reply: {
                          id: 'cod_cancel_777111333',
                          title: 'Cancel Order'
                        }
                      }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      await axios.post(`${baseUrl}/api/webhooks/whatsapp`, buttonCancelPayload);
      await new Promise(r => setTimeout(r, 200));
      const cancelledOrder = findCodOrderById('777111333');
      assert.strictEqual(cancelledOrder.status, 'cancelled');
      console.log('✔ WhatsApp button click "Cancel Order" passed! Order status updated to cancelled.');

      // 3f. Test text message fallback ("confirm" / "cancel")
      const textOrderPayload = {
        id: 777111444,
        order_number: 1057,
        name: '#1057',
        currency: 'INR',
        total_price: '599.00',
        tags: 'COD, VIP',
        shipping_address: {
          first_name: 'Amit',
          phone: '9888877777'
        },
        line_items: [
          { title: 'Watch' }
        ]
      };

      await axios.post(`${baseUrl}/api/webhooks/orders/create`, textOrderPayload);
      await new Promise(r => setTimeout(r, 200));
      
      const textMsgPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: '919888877777',
                      id: 'wamid.test_text_confirm',
                      type: 'text',
                      text: { body: 'Confirm Order' }
                    }
                  ]
                }
              }
            ]
          }
        ]
      };

      await axios.post(`${baseUrl}/api/webhooks/whatsapp`, textMsgPayload);
      await new Promise(r => setTimeout(r, 200));
      const textConfirmedOrder = findCodOrderById('777111444');
      assert.strictEqual(textConfirmedOrder.status, 'confirmed');
      console.log('✔ WhatsApp text message reply "Confirm Order" passed! Order status updated.');

      console.log('\n========================================');
      console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');
      console.log('========================================\n');

    } catch (testErr) {
      console.error('Test failed:', testErr);
      process.exitCode = 1;
    } finally {
      server.close();
    }
  });
})();
