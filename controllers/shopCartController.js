import ShopCart from '../models/ShopCart.js';
import Product from '../models/Product.js';
import { mapProduct } from './productController.js';

async function getOrCreateCart(userId) {
  let cart = await ShopCart.findOne({ userId });
  if (!cart) {
    cart = await ShopCart.create({ userId, items: [] });
  }
  return cart;
}

async function buildCartResponse(cart) {
  const items = cart.items || [];
  if (!items.length) {
    return { items: [], itemCount: 0, subtotal: 0 };
  }

  const productIds = items.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds }, isActive: true }).lean();
  const byId = new Map(products.map((p) => [String(p._id), p]));

  let itemCount = 0;
  let subtotal = 0;
  const lines = [];

  for (const item of items) {
    const product = byId.get(String(item.productId));
    if (!product) continue;
    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const price = Number(product.price) || 0;
    const lineTotal = price * quantity;
    itemCount += quantity;
    subtotal += lineTotal;
    lines.push({
      productId: String(product._id),
      quantity,
      product: mapProduct(product),
      lineTotal,
    });
  }

  return { items: lines, itemCount, subtotal };
}

export async function getShopCart(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const cart = await getOrCreateCart(userId);
    const data = await buildCartResponse(cart);
    return res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function upsertShopCartItem(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    const productId = String(req.body?.productId || '').trim();
    const quantity = Math.floor(Number(req.body?.quantity));
    if (!productId) {
      return res.status(400).json({ message: 'productId is required' });
    }

    const cart = await getOrCreateCart(userId);
    const idx = cart.items.findIndex((i) => String(i.productId) === productId);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      if (idx >= 0) cart.items.splice(idx, 1);
    } else {
      const product = await Product.findOne({ _id: productId, isActive: true });
      if (!product) return res.status(404).json({ message: 'Product not found' });
      if (quantity > product.stock) {
        return res.status(400).json({ message: `Only ${product.stock} in stock` });
      }
      if (idx >= 0) cart.items[idx].quantity = quantity;
      else cart.items.push({ productId, quantity });
    }

    await cart.save();
    const data = await buildCartResponse(cart);
    return res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function clearShopCart(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    await ShopCart.findOneAndUpdate({ userId }, { $set: { items: [] } }, { upsert: true });
    return res.json({ items: [], itemCount: 0, subtotal: 0 });
  } catch (err) {
    next(err);
  }
}
