# Stepwise WhatsApp & Shopify Integration

Automated WhatsApp notifications and interactive COD (Cash on Delivery) order confirmation system integrated with Shopify webhooks and Meta WhatsApp Cloud API.

---

## Features

- **COD Order Confirmation**: Automatically detects Cash on Delivery orders from Shopify and sends an interactive WhatsApp message with **Confirm Order** and **Cancel Order** buttons.
- **WhatsApp Webhook Handling**: Receives customer responses (button clicks and text replies like "Confirm", "Cancel", "1", "2").
- **Shopify Order Status Updates**:
  - Adds `COD-Pending` tag when an order is created.
  - Updates tag to `COD-Confirmed` with a timeline note when the customer confirms.
  - Updates tag to `COD-Cancelled`, adds a timeline note, and calls Shopify's Cancel API (`/admin/api/{version}/orders/{id}/cancel.json`) with restock when cancelled.
- **Prepaid & Existing Orders**: Non-COD orders continue sending the standard order template without disruption.
- **Order Fulfillment & Tracking**: Webhook listeners for order fulfillment (`orders/fulfilled`) and tracking updates (`orders/updated`).

---

## Architecture & Workflow

```
[Customer Places COD Order on Shopify]
                  │
                  ▼
        Shopify Webhook
     (POST /api/webhooks/orders/create)
                  │
                  ├──> Tags Shopify Order: [COD-Pending]
                  │
                  ▼
   WhatsApp Interactive Message Sent
  [Confirm Order]    [Cancel Order]
         │                 │
         └────────┬────────┘
                  │ Customer Clicks Button
                  ▼
        Meta WhatsApp Webhook
       (POST /api/webhooks/whatsapp)
                  │
        ┌─────────┴─────────┐
        ▼                   ▼
 [Confirm Order]     [Cancel Order]
        │                   │
        ├─ Tag:             ├─ Tag:
        │  [COD-Confirmed]  │  [COD-Cancelled]
        ├─ Timeline Note    ├─ Cancel in Shopify
        └─ WhatsApp Reply   └─ WhatsApp Reply
```

---

## Environment Variables (`.env`)

```env
PORT=5000

# WhatsApp Cloud API Credentials
WHATSAPP_TOKEN=your_meta_system_user_token
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_TEMPLATE_NAME=order_confirmation
WHATSAPP_SHIPPED_TEMPLATE_NAME=order_shipped
WHATSAPP_TEMPLATE_LANG=en_US

# WhatsApp Webhook Verification Token (set matching token in Meta App Dashboard)
WHATSAPP_VERIFY_TOKEN=stepwise_webhook_verify_token

# Optional: Meta Template for COD (if using pre-approved template with buttons)
# WHATSAPP_COD_TEMPLATE_NAME=cod_order_confirmation

# Shopify Admin API Configuration (for live order status updates & cancellation)
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2024-01

# Optional: Custom COD payment gateway keywords (comma-separated)
# COD_GATEWAY_NAMES=cod,cash on delivery,cash_on_delivery,manual,cash
```

---

## Endpoints

### Shopify Webhooks
- `POST /api/webhooks/orders/create` - Triggered when a new order is placed in Shopify.
- `POST /api/webhooks/orders/fulfilled` - Triggered when an order is fulfilled.
- `POST /api/webhooks/orders/updated` - Triggered when tracking details are updated.

### WhatsApp Webhooks
- `GET /api/webhooks/whatsapp` - Meta challenge verification endpoint.
- `POST /api/webhooks/whatsapp` - Receives button clicks and incoming messages from customers.

### Testing Endpoints
- `POST /api/whatsapp/order-confirmation` - Manually trigger prepaid template confirmation.
- `POST /api/whatsapp/cod-confirmation` - Manually test COD confirmation message with interactive buttons.
- `GET /api/webhooks/cod-orders` - Inspect cached COD orders and their current status (`pending`, `confirmed`, `cancelled`).

---

## Setup Instructions

### 1. Shopify Webhook Setup
1. In your Shopify Admin, go to **Settings > Notifications > Webhooks** (or via an App).
2. Click **Create Webhook**.
3. Event: `Order creation`
4. Format: `JSON`
5. URL: `https://<YOUR_DOMAIN>/api/webhooks/orders/create`
6. Save webhook.

### 2. Meta WhatsApp Webhook Setup
1. Open the [Meta for Developers App Dashboard](https://developers.facebook.com/).
2. Navigate to **WhatsApp > Configuration**.
3. Under **Webhook**, click **Edit**.
4. Callback URL: `https://<YOUR_DOMAIN>/api/webhooks/whatsapp`
5. Verify Token: Value of `WHATSAPP_VERIFY_TOKEN` in your `.env` (default: `stepwise_webhook_verify_token`).
6. Click **Verify and save**.
7. Under Webhook fields, click **Manage** and subscribe to **`messages`**.

---

## Running the Project

```bash
# Start server
npm start

# Run end-to-end tests
npm test
```

