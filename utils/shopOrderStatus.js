import { SHOP_ORDER_STATUSES } from '../models/ShopOrder.js';

const ADMIN_TRANSITIONS = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['shipped', 'cancelled'],
  shipped: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

export function canAdminTransition(from, to) {
  if (!SHOP_ORDER_STATUSES.includes(from) || !SHOP_ORDER_STATUSES.includes(to)) return false;
  return (ADMIN_TRANSITIONS[from] || []).includes(to);
}

export function shopOrderStatusLabel(status) {
  const labels = {
    placed: 'Placed',
    confirmed: 'Confirmed',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
  };
  return labels[status] || status;
}
