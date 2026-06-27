import ShopCart from '../models/ShopCart.js';
import ShopOrder from '../models/ShopOrder.js';
import Product from '../models/Product.js';
import User from '../models/User.js';
import { generateShopOrderNumber } from '../utils/shopOrderNumber.js';
import { canAdminTransition } from '../utils/shopOrderStatus.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function roundMoney(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function mapShopOrder(doc, { includeUser = false } = {}) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : doc;
  const base = {
    _id: o._id?.toString?.() || o._id,
    orderNumber: o.orderNumber,
    userId: o.userId?.toString?.() || o.userId,
    items: o.items || [],
    shippingAddress: o.shippingAddress || {},
    customerPhone: o.customerPhone || '',
    customerName: o.customerName || '',
    subtotal: roundMoney(o.subtotal),
    total: roundMoney(o.total),
    paymentMethod: o.paymentMethod || 'cod',
    status: o.status,
    statusHistory: o.statusHistory || [],
    cancelReason: o.cancelReason || '',
    patientNote: o.patientNote || '',
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
  if (includeUser && o.userId && typeof o.userId === 'object') {
    base.customer = {
      _id: o.userId._id?.toString?.() || o.userId._id,
      name: o.userId.name || '',
      phone: o.userId.phone || '',
      email: o.userId.email || '',
    };
  }
  return base;
}

async function restoreStockForOrder(order) {
  for (const item of order.items || []) {
    await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
  }
}

export async function placeShopOrder(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const user = await User.findById(userId).lean();
    if (!user) return res.status(401).json({ message: 'Unauthorized' });

    const cart = await ShopCart.findOne({ userId });
    if (!cart?.items?.length) {
      return res.status(400).json({ message: 'Your cart is empty' });
    }

    const bodyAddr = req.body?.shippingAddress;
    const shippingAddress = {
      text: String(bodyAddr?.text || user.address?.text || '').trim(),
      lat: bodyAddr?.lat ?? user.address?.lat ?? null,
      lng: bodyAddr?.lng ?? user.address?.lng ?? null,
    };
    if (!shippingAddress.text) {
      return res.status(400).json({ message: 'Delivery address is required', errors: { address: 'Required' } });
    }

    const productIds = cart.items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, isActive: true }).lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const orderItems = [];
    let subtotal = 0;

    for (const line of cart.items) {
      const product = byId.get(String(line.productId));
      if (!product) {
        return res.status(400).json({ message: 'A product in your cart is no longer available' });
      }
      const quantity = Math.max(1, Math.floor(Number(line.quantity) || 1));
      if (quantity > product.stock) {
        return res.status(400).json({ message: `Not enough stock for ${product.name}` });
      }
      const price = Number(product.price) || 0;
      subtotal += price * quantity;
      orderItems.push({
        productId: product._id,
        name: product.name,
        price,
        quantity,
        imageUrl: (product.imageUrls && product.imageUrls[0]) || '',
      });
    }

    const decremented = [];
    for (const item of orderItems) {
      const updated = await Product.findOneAndUpdate(
        { _id: item.productId, stock: { $gte: item.quantity }, isActive: true },
        { $inc: { stock: -item.quantity } },
        { new: true },
      );
      if (!updated) {
        for (const prev of decremented) {
          await Product.updateOne({ _id: prev.productId }, { $inc: { stock: prev.quantity } });
        }
        return res.status(400).json({ message: `Not enough stock for ${item.name}` });
      }
      decremented.push({ productId: item.productId, quantity: item.quantity });
    }

    const orderNumber = await generateShopOrderNumber();
    const now = new Date();
    let order;
    try {
      order = await ShopOrder.create({
        orderNumber,
        userId,
        items: orderItems,
        shippingAddress,
        customerPhone: user.phone || '',
        customerName: user.name || '',
        subtotal: roundMoney(subtotal),
        total: roundMoney(subtotal),
        paymentMethod: 'cod',
        status: 'placed',
        statusHistory: [{ status: 'placed', at: now, byRole: 'user', note: '' }],
        patientNote: String(req.body?.patientNote || '').trim().slice(0, 500),
      });
    } catch (createErr) {
      for (const prev of decremented) {
        await Product.updateOne({ _id: prev.productId }, { $inc: { stock: prev.quantity } });
      }
      throw createErr;
    }

    cart.items = [];
    await cart.save();

    return res.status(201).json(mapShopOrder(order));
  } catch (err) {
    next(err);
  }
}

export async function listPatientShopOrders(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const { page, limit, skip } = readPagination(req.query);
    const filter = { userId };
    const [rows, total] = await Promise.all([
      ShopOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ShopOrder.countDocuments(filter),
    ]);

    return res.json({
      data: rows.map((r) => mapShopOrder(r)),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

export async function getPatientShopOrderById(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const order = await ShopOrder.findOne({ _id: req.params.id, userId }).lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    return res.json(mapShopOrder(order));
  } catch (err) {
    next(err);
  }
}

export async function listAdminShopOrders(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const filter = {};
    const status = String(req.query?.status || '').trim();
    if (status) filter.status = status;

    const search = String(req.query?.search || '').trim();
    if (search) {
      filter.$or = [
        { orderNumber: new RegExp(search, 'i') },
        { customerPhone: new RegExp(search, 'i') },
        { customerName: new RegExp(search, 'i') },
      ];
    }

    const [rows, total] = await Promise.all([
      ShopOrder.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'name phone email')
        .lean(),
      ShopOrder.countDocuments(filter),
    ]);

    return res.json({
      data: rows.map((r) => mapShopOrder(r, { includeUser: true })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

export async function getAdminShopOrderById(req, res, next) {
  try {
    const order = await ShopOrder.findById(req.params.id).populate('userId', 'name phone email').lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    return res.json(mapShopOrder(order, { includeUser: true }));
  } catch (err) {
    next(err);
  }
}

export async function patchAdminShopOrderStatus(req, res, next) {
  try {
    const order = await ShopOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const nextStatus = String(req.body?.status || '').trim();
    if (!canAdminTransition(order.status, nextStatus)) {
      return res.status(400).json({ message: `Cannot change status from ${order.status} to ${nextStatus}` });
    }

    const note = String(req.body?.note || '').trim();
    const cancelReason = String(req.body?.cancelReason || '').trim();

    if (nextStatus === 'cancelled' && !cancelReason) {
      return res.status(400).json({ message: 'Cancel reason is required', errors: { cancelReason: 'Required' } });
    }

    if (nextStatus === 'cancelled' && order.status !== 'delivered') {
      await restoreStockForOrder(order);
      order.cancelReason = cancelReason;
    }

    order.status = nextStatus;
    order.statusHistory.push({ status: nextStatus, at: new Date(), byRole: 'admin', note: note || cancelReason });
    await order.save();

    return res.json(mapShopOrder(order));
  } catch (err) {
    next(err);
  }
}

export async function cancelAdminShopOrder(req, res, next) {
  req.body = { ...req.body, status: 'cancelled' };
  return patchAdminShopOrderStatus(req, res, next);
}
