const fs = require('fs');
const path = require('path');

const COD_CACHE_FILE = path.join(__dirname, '..', 'cod_orders_cache.json');

/**
 * Load cached COD orders from JSON file
 */
const loadCodCache = () => {
  if (!fs.existsSync(COD_CACHE_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(COD_CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading COD cache file:', err);
    return [];
  }
};

/**
 * Save COD orders cache to JSON file
 */
const saveCodCache = (cache) => {
  try {
    fs.writeFileSync(COD_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing COD cache file:', err);
  }
};

/**
 * Save or update a pending COD order
 */
const savePendingCodOrder = ({
  orderId,
  orderNumber,
  phone,
  customerName,
  productName,
  total,
  storeDomain
}) => {
  const cache = loadCodCache();
  const idStr = String(orderId);
  const existingIndex = cache.findIndex(item => String(item.orderId) === idStr);

  const orderRecord = {
    orderId: idStr,
    orderNumber: orderNumber || '',
    phone: phone || '',
    customerName: customerName || 'Valued Customer',
    productName: productName || 'Your Order',
    total: total || '',
    storeDomain: storeDomain || '',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    cache[existingIndex] = {
      ...cache[existingIndex],
      ...orderRecord,
      createdAt: cache[existingIndex].createdAt || orderRecord.createdAt
    };
  } else {
    cache.push(orderRecord);
  }

  saveCodCache(cache);
  return orderRecord;
};

/**
 * Find order by Shopify order ID
 */
const findCodOrderById = (orderId) => {
  if (!orderId) return null;
  const cache = loadCodCache();
  const idStr = String(orderId);
  return cache.find(item => String(item.orderId) === idStr) || null;
};

/**
 * Find the latest pending COD order by customer phone number
 */
const findLatestPendingCodOrderByPhone = (phone) => {
  if (!phone) return null;
  const cleanPhone = String(phone).replace(/\D/g, '');
  const last10 = cleanPhone.slice(-10);

  const cache = loadCodCache();

  // 1. Prefer most recent order in 'pending' status
  for (let i = cache.length - 1; i >= 0; i--) {
    const item = cache[i];
    const itemClean = String(item.phone || '').replace(/\D/g, '');
    if (itemClean.slice(-10) === last10 && item.status === 'pending') {
      return item;
    }
  }

  // 2. Fall back to most recent order matching phone
  for (let i = cache.length - 1; i >= 0; i--) {
    const item = cache[i];
    const itemClean = String(item.phone || '').replace(/\D/g, '');
    if (itemClean.slice(-10) === last10) {
      return item;
    }
  }

  return null;
};

/**
 * Update status of a COD order in cache ('confirmed' or 'cancelled')
 */
const updateCodOrderStatus = (orderId, status) => {
  const cache = loadCodCache();
  const idStr = String(orderId);
  const item = cache.find(it => String(it.orderId) === idStr);
  if (item) {
    item.status = status;
    item.updatedAt = new Date().toISOString();
    saveCodCache(cache);
    return item;
  }
  return null;
};

module.exports = {
  loadCodCache,
  saveCodCache,
  savePendingCodOrder,
  findCodOrderById,
  findLatestPendingCodOrderByPhone,
  updateCodOrderStatus
};

