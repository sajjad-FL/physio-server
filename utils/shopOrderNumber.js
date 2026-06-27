import ShopOrder from '../models/ShopOrder.js';

function datePart(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function generateShopOrderNumber() {
  const prefix = `SH-${datePart()}-`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const seq = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const orderNumber = `${prefix}${seq}`;
    const exists = await ShopOrder.exists({ orderNumber });
    if (!exists) return orderNumber;
  }
  return `${prefix}${Date.now().toString().slice(-4)}`;
}
