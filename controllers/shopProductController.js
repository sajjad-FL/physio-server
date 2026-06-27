import Product from '../models/Product.js';
import { mapProduct } from './productController.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export async function listShopProducts(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const filter = { isActive: true };
    const [rows, total] = await Promise.all([
      Product.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments(filter),
    ]);
    return res.json({
      data: rows.map(mapProduct),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}

export async function getShopProductById(req, res, next) {
  try {
    const doc = await Product.findOne({ _id: req.params.id, isActive: true });
    if (!doc) return res.status(404).json({ message: 'Product not found' });
    return res.json(mapProduct(doc));
  } catch (err) {
    next(err);
  }
}
