const fs = require('fs');
const path = require('path');

const BOOKINGS_CACHE_FILE = path.join(__dirname, '..', 'bookings_cache.json');

/**
 * Load cached booking order IDs
 */
const loadBookingsCache = () => {
  if (!fs.existsSync(BOOKINGS_CACHE_FILE)) {
    return [];
  }
  try {
    const data = fs.readFileSync(BOOKINGS_CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading bookings cache:', err.message);
    return [];
  }
};

/**
 * Save bookings cache to file
 */
const saveBookingsCache = (cache) => {
  try {
    fs.writeFileSync(BOOKINGS_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing bookings cache:', err.message);
  }
};

/**
 * Check if an order ID has already been processed for booking confirmation
 */
const isBookingProcessed = (orderId) => {
  if (!orderId) return false;
  const cache = loadBookingsCache();
  const idStr = String(orderId);
  return cache.some(item => (typeof item === 'object' ? String(item.orderId) === idStr : String(item) === idStr));
};

/**
 * Mark an order ID as processed
 */
const markBookingProcessed = (orderId, details = {}) => {
  if (!orderId) return;
  const cache = loadBookingsCache();
  const idStr = String(orderId);

  const existingIndex = cache.findIndex(item => 
    (typeof item === 'object' ? String(item.orderId) === idStr : String(item) === idStr)
  );

  const record = {
    orderId: idStr,
    orderNumber: details.orderNumber || '',
    phone: details.phone || '',
    patientName: details.patientName || '',
    appointmentDate: details.appointmentDate || '',
    timeSlot: details.timeSlot || '',
    amount: details.amount || '',
    processedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    cache[existingIndex] = record;
  } else {
    cache.push(record);
  }

  saveBookingsCache(cache);
  return record;
};

module.exports = {
  loadBookingsCache,
  saveBookingsCache,
  isBookingProcessed,
  markBookingProcessed
};
