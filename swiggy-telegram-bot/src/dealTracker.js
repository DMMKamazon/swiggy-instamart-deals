const fs = require('fs');
const path = require('path');

function getCacheFilePath(campaignKey = 'default', storeId = 'default') {
  return path.join(__dirname, '..', 'data', `deals_cache_${storeId}_${campaignKey}.json`);
}

function ensureDataDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCache(campaignKey = 'default', storeId = 'default') {
  const filePath = getCacheFilePath(campaignKey, storeId);
  ensureDataDir(filePath);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {}
  return { items: {} };
}

function saveCache(cache, campaignKey = 'default', storeId = 'default') {
  const filePath = getCacheFilePath(campaignKey, storeId);
  ensureDataDir(filePath);
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {}
}

function getIstContext(overrideDate = null, overrideHour = null) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  let istDate = overrideDate ? new Date(`${overrideDate}T${String(overrideHour || 0).padStart(2, '0')}:00:00.000Z`) : new Date(now.getTime() + istOffset);
  const dateStr = overrideDate || istDate.toISOString().slice(0, 10);
  const hour = overrideHour !== null ? overrideHour : istDate.getUTCHours();
  return { dateStr, hour, now: now.getTime() };
}

function normalizeProductName(name) {
  if (!name) return '';
  let str = name.trim().toLowerCase();
  str = str.replace(/\([^)]*\)/g, ' ');
  str = str.replace(/[-\s,]+(?:uk\s*\d+|\d+\s*uk)\b/gi, ' ');
  return str.replace(/[-_,\s]+/g, ' ').trim();
}

function getCanonicalItemKey(item) {
  const packStr = (item.pack || '').trim().toLowerCase();
  const rawName = (item.name || '').trim().toLowerCase();
  
  if (rawName) {
    return packStr ? `name:${rawName}:${packStr}` : `name:${rawName}`;
  }
  if (item.parentProductId) {
    return packStr ? `pid:${item.parentProductId}:${packStr}` : `pid:${item.parentProductId}`;
  }
  return String(item.skuId || '');
}

function evaluateCustomRules(item) {
  const cat = (item.category || '').toLowerCase() + ' ' + (item.subCategory || '').toLowerCase();
  const isElectronics = cat.includes('electronic') || cat.includes('appliance') || cat.includes('mobile') || cat.includes('earphone') || cat.includes('laptop') || cat.includes('battery');

  let isGlitch = false;
  if (item.price <= 50 && (isElectronics || cat.includes('skincare') || item.mrp >= 400)) {
    isGlitch = true;
  }

  // Threshold rules: Strictly above 94% (> 94 => >= 95) for electronics, >= 80% for everything else
  let customThreshold = isElectronics ? 95 : 80;

  let tier = 'TIER_LOW';
  if (isGlitch) {
    tier = 'GLITCH';
  } else if (item.discount >= customThreshold) {
    tier = 'MEGA_LOOT';
  }

  return { threshold: customThreshold, tier };
}

function findAlertWorthyDeals(items, minDiscount = 80, campaignKey = 'default', options = {}) {
  const storeId = options.storeId || 'default';
  const cache = loadCache(campaignKey, storeId);
  const alertList = [];
  const now = new Date().getTime();
  const seenInCurrentRun = new Map();

  for (const item of items) {
    const rule = evaluateCustomRules(item);
    
    // Hard filter: skip anything below required discount unless it's a confirmed glitch
    if (item.discount < rule.threshold && rule.tier !== 'GLITCH') continue;
    item.tier = rule.tier;

    const itemKey = getCanonicalItemKey(item);
    if (!itemKey) continue;

    if (seenInCurrentRun.has(itemKey)) {
      const existingAlert = seenInCurrentRun.get(itemKey);
      if (item.price < existingAlert.price) {
        existingAlert.price = item.price;
        existingAlert.mrp = item.mrp;
        existingAlert.discount = item.discount;
        if (cache.items[itemKey]) {
          cache.items[itemKey].price = item.price;
          cache.items[itemKey].discount = item.discount;
        }
      }
      continue;
    }

    const prev = cache.items[itemKey];
    let shouldAlert = false;
    let alertType = 'NEW_DEAL';

    if (!prev) {
      shouldAlert = true;
    } else {
      const lastAlertPrice = prev.lastAlertedPrice !== undefined ? prev.lastAlertedPrice : null;
      const lastSeenPrice = prev.price !== undefined ? prev.price : null;

      if (lastAlertPrice === null) {
        shouldAlert = true;
      } else if (item.price < lastAlertPrice) {
        shouldAlert = true;
        alertType = 'PRICE_DROP';
      } else if (lastSeenPrice !== null && item.price < lastSeenPrice && item.price <= lastAlertPrice) {
        shouldAlert = true;
      }
    }

    if (shouldAlert) {
      const alertObj = { ...item, alertType, prevPrice: prev ? prev.lastAlertedPrice : null, campaignKey };
      alertList.push(alertObj);
      seenInCurrentRun.set(itemKey, alertObj);

      cache.items[itemKey] = {
        name: item.name, pack: item.pack || '', category: item.category || '',
        price: item.price, mrp: item.mrp, discount: item.discount,
        lastAlertedPrice: item.price, lastAlertedDiscount: item.discount,
        firstSeen: prev ? prev.firstSeen : now, lastSeen: now
      };
    } else {
      seenInCurrentRun.set(itemKey, { price: item.price });
      if (!cache.items[itemKey]) {
        cache.items[itemKey] = {
          name: item.name, pack: item.pack || '', category: item.category || '',
          price: item.price, mrp: item.mrp, discount: item.discount,
          firstSeen: now, lastSeen: now
        };
      } else {
        cache.items[itemKey].price = item.price;
        cache.items[itemKey].discount = item.discount;
        cache.items[itemKey].lastSeen = now;
      }
    }
  }

  alertList.sort((a, b) => b.discount - a.discount);
  saveCache(cache, campaignKey, storeId);
  return alertList;
}

function getCachedDeals(campaignKey = 'default', minDiscount = 0, storeId = 'default') {
  const cache = loadCache(campaignKey, storeId);
  const result = [];
  for (const val of Object.values(cache.items || {})) {
    if (val.discount >= minDiscount) result.push(val);
  }
  return result.sort((a, b) => b.discount - a.discount);
}

module.exports = {
  loadCache,
  saveCache,
  findAlertWorthyDeals,
  getCachedDeals,
  getIstContext,
  getCanonicalItemKey,
  normalizeProductName
};
