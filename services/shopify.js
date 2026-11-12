const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const TOKENS_FILE = path.join(__dirname, '..', 'shopify_tokens.json');

// In-memory cache for Client Credentials tokens (24h TTL)
const clientCredCache = {};

/**
 * Load saved OAuth tokens per store domain
 */
const loadTokens = () => {
  if (!fs.existsSync(TOKENS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
  } catch (err) {
    console.error('[Shopify] Error reading tokens file:', err.message);
    return {};
  }
};

/**
 * Save OAuth token for a store domain
 */
const saveStoreToken = (shopDomain, accessToken) => {
  const cleanShop = cleanDomain(shopDomain);
  const tokens = loadTokens();
  tokens[cleanShop] = {
    accessToken,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
    console.log(`[Shopify] Saved access token for ${cleanShop}`);
  } catch (err) {
    console.error('[Shopify] Error saving tokens file:', err.message);
  }
};

const cleanDomain = (domain) => {
  return (domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim().toLowerCase();
};

/**
 * Helper to get Shopify credentials and configurations
 */
const getShopifyConfig = (overrideDomain) => {
  const domain = cleanDomain(overrideDomain || process.env.SHOPIFY_SHOP_DOMAIN);
  const staticToken = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '').trim();
  const clientId = (process.env.SHOPIFY_CLIENT_ID || '').trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();
  const version = (process.env.SHOPIFY_API_VERSION || '2024-01').trim();

  return { domain, staticToken, clientId, clientSecret, version };
};

/**
 * Exchange OAuth authorization code for a permanent offline access token
 */
const exchangeOAuthCode = async (shopDomain, code) => {
  const cleanShop = cleanDomain(shopDomain);
  const { clientId, clientSecret } = getShopifyConfig(cleanShop);

  if (!clientId || !clientSecret) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be configured in .env');
  }

  const url = `https://${cleanShop}/admin/oauth/access_token`;
  const response = await axios.post(url, {
    client_id: clientId,
    client_secret: clientSecret,
    code
  });

  const accessToken = response.data?.access_token;
  if (!accessToken) {
    throw new Error('No access_token returned from Shopify OAuth');
  }

  saveStoreToken(cleanShop, accessToken);
  return accessToken;
};

/**
 * Resolve Admin API Access Token for a store:
 * 1. Explicit SHOPIFY_ADMIN_ACCESS_TOKEN from .env
 * 2. Saved OAuth token from shopify_tokens.json
 * 3. Client Credentials Grant using SHOPIFY_CLIENT_ID & SHOPIFY_CLIENT_SECRET (auto-refreshes every 24h)
 */
const getAccessToken = async (storeDomain) => {
  const { domain, staticToken, clientId, clientSecret } = getShopifyConfig(storeDomain);
  if (!domain) return null;

  // 1. Static token in .env
  if (staticToken) {
    return staticToken;
  }

  // 2. Saved OAuth token
  const savedTokens = loadTokens();
  if (savedTokens[domain]?.accessToken) {
    return savedTokens[domain].accessToken;
  }

  // 3. Client Credentials Grant (Shopify Dev Dashboard)
  if (clientId && clientSecret) {
    const cached = clientCredCache[domain];
    if (cached && cached.expiresAt > Date.now()) {
      return cached.accessToken;
    }

    try {
      const url = `https://${domain}/admin/oauth/access_token`;
      const params = new URLSearchParams();
      params.append('grant_type', 'client_credentials');
      params.append('client_id', clientId);
      params.append('client_secret', clientSecret);

      const response = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const accessToken = response.data?.access_token;
      const expiresIn = response.data?.expires_in || 86400; // default 24h

      if (accessToken) {
        clientCredCache[domain] = {
          accessToken,
          // Refresh 5 minutes before actual expiry
          expiresAt: Date.now() + Math.max(expiresIn - 300, 60) * 1000
        };
        console.log(`[Shopify] Acquired Admin API token via Client Credentials for ${domain}`);
        return accessToken;
      }
    } catch (err) {
      console.warn(`[Shopify] Client Credentials grant failed for ${domain}:`, err.response?.data || err.message);
    }
  }

  return null;
};

/**
 * Check if Shopify Admin API credentials are configured
 */
const isConfigured = (overrideDomain) => {
  const { domain, staticToken, clientId, clientSecret } = getShopifyConfig(overrideDomain);
  const savedTokens = loadTokens();
  const hasToken = Boolean(staticToken || (domain && savedTokens[domain]?.accessToken) || (clientId && clientSecret));
  return Boolean(domain && hasToken);
};

/**
 * Shopify Admin REST API headers
 */
const getHeaders = (token) => ({
  'X-Shopify-Access-Token': token,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
});

/**
 * Fetch order details from Shopify Admin API
 */
const getOrder = async (orderId, storeDomain) => {
  const { domain, version } = getShopifyConfig(storeDomain);
  const token = await getAccessToken(domain);
  if (!domain || !token) {
    console.warn(`[Shopify] Credentials not configured. Cannot get order ${orderId}.`);
    return null;
  }

  try {
    const url = `https://${domain}/admin/api/${version}/orders/${orderId}.json`;
    const response = await axios.get(url, { headers: getHeaders(token) });
    return response.data?.order;
  } catch (err) {
    console.error(`[Shopify] Error fetching order ${orderId}:`, err.response?.data || err.message);
    return null;
  }
};

/**
 * Update order tags and notes in Shopify
 */
const updateOrderTagsAndNote = async (orderId, { addTags = [], removeTags = [], noteAppend = '' }, storeDomain) => {
  const { domain, version } = getShopifyConfig(storeDomain);
  const token = await getAccessToken(domain);

  if (!domain || !token) {
    console.log(`[Shopify Notice] Shopify credentials (Token or Client ID/Secret) not configured or app not installed on ${domain || 'store'}.`);
    console.log(`[Shopify Notice] Simulated order ${orderId} update: addTags=[${addTags.join(', ')}], removeTags=[${removeTags.join(', ')}], note="${noteAppend}"`);
    return { success: true, simulated: true };
  }

  try {
    // 1. Fetch current order to preserve existing tags & note
    const currentOrder = await getOrder(orderId, domain);
    let existingTags = [];
    let currentNote = '';

    if (currentOrder) {
      if (typeof currentOrder.tags === 'string') {
        existingTags = currentOrder.tags
          .split(',')
          .map(t => t.trim())
          .filter(Boolean);
      }
      currentNote = currentOrder.note || '';
    }

    // Filter out removeTags and add addTags
    const removeSet = new Set(removeTags.map(t => t.toLowerCase()));
    let updatedTags = existingTags.filter(t => !removeSet.has(t.toLowerCase()));

    for (const tag of addTags) {
      if (!updatedTags.some(t => t.toLowerCase() === tag.toLowerCase())) {
        updatedTags.push(tag);
      }
    }

    let updatedNote = currentNote;
    if (noteAppend) {
      updatedNote = currentNote ? `${currentNote}\n${noteAppend}` : noteAppend;
    }

    const url = `https://${domain}/admin/api/${version}/orders/${orderId}.json`;
    const payload = {
      order: {
        id: orderId,
        tags: updatedTags.join(', '),
        note: updatedNote
      }
    };

    const response = await axios.put(url, payload, { headers: getHeaders(token) });
    console.log(`[Shopify] Successfully updated order ${orderId} tags to: "${updatedTags.join(', ')}"`);
    return { success: true, data: response.data?.order };
  } catch (err) {
    console.error(`[Shopify] Failed to update order ${orderId}:`, err.response?.data || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
};

/**
 * Mark order as COD-Pending when received
 */
const markOrderCodPending = async (orderId, storeDomain) => {
  const timestamp = new Date().toISOString();
  return updateOrderTagsAndNote(orderId, {
    addTags: ['COD-Pending'],
    removeTags: ['COD-Confirmed', 'COD-Cancelled'],
    noteAppend: `[WhatsApp COD]: Confirmation request sent to customer on ${timestamp}`
  }, storeDomain);
};

/**
 * Mark order as COD-Confirmed when customer confirms via WhatsApp
 */
const confirmOrder = async (orderId, storeDomain) => {
  const timestamp = new Date().toISOString();
  return updateOrderTagsAndNote(orderId, {
    addTags: ['COD-Confirmed'],
    removeTags: ['COD-Pending', 'COD-Cancelled'],
    noteAppend: `[WhatsApp COD]: Confirmed by customer via WhatsApp on ${timestamp}`
  }, storeDomain);
};

/**
 * Cancel COD order in Shopify when customer cancels via WhatsApp
 */
const cancelCodOrder = async (orderId, storeDomain, reason = 'customer') => {
  const { domain, version } = getShopifyConfig(storeDomain);
  const timestamp = new Date().toISOString();

  // 1. Update order tags and note
  await updateOrderTagsAndNote(orderId, {
    addTags: ['COD-Cancelled'],
    removeTags: ['COD-Pending', 'COD-Confirmed'],
    noteAppend: `[WhatsApp COD]: Cancelled by customer via WhatsApp on ${timestamp}`
  }, storeDomain);

  // 2. Call Shopify cancel API
  const token = await getAccessToken(domain);
  if (!domain || !token) {
    console.log(`[Shopify Notice] Simulated order ${orderId} cancellation in Shopify Admin API.`);
    return { success: true, simulated: true };
  }

  try {
    const url = `https://${domain}/admin/api/${version}/orders/${orderId}/cancel.json`;
    const payload = {
      reason,
      email: false,
      restock: true
    };
    const response = await axios.post(url, payload, { headers: getHeaders(token) });
    console.log(`[Shopify] Order ${orderId} successfully cancelled via Shopify Admin API.`);
    return { success: true, data: response.data?.order };
  } catch (err) {
    console.warn(`[Shopify] Order ${orderId} cancel API notice:`, err.response?.data?.errors || err.message);
    return { success: false, error: err.response?.data || err.message };
  }
};

module.exports = {
  getShopifyConfig,
  getAccessToken,
  exchangeOAuthCode,
  saveStoreToken,
  isConfigured,
  getOrder,
  updateOrderTagsAndNote,
  markOrderCodPending,
  confirmOrder,
  cancelCodOrder
};
