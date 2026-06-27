import Product from '../models/Product.js';
import mongoose from 'mongoose';
import { persistProductImages } from '../utils/productFilePersist.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export function mapProduct(doc) {
  if (!doc) return null;
  const p = doc.toObject ? doc.toObject() : doc;
  const imageUrls = Array.isArray(p.imageUrls) ? p.imageUrls : [];
  return {
    _id: p._id?.toString?.() || p._id,
    name: p.name,
    description: p.description || '',
    price: Number(p.price) || 0,
    imageUrls,
    imageUrl: imageUrls[0] || '',
    stock: Math.max(0, Math.floor(Number(p.stock) || 0)),
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function parseBool(v, fallback = true) {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 'true' || v === '1' || v === 'on') return true;
  if (v === false || v === 'false' || v === '0' || v === 'off') return false;
  return fallback;
}

function parseKeepImageUrls(body, existing = []) {
  if (body?.keepImageUrls === undefined || body?.keepImageUrls === null || body?.keepImageUrls === '') {
    return existing;
  }
  try {
    const parsed = typeof body.keepImageUrls === 'string' ? JSON.parse(body.keepImageUrls) : body.keepImageUrls;
    return Array.isArray(parsed) ? parsed.map(String) : existing;
  } catch {
    return existing;
  }
}

function validateProductFields(body, { requireImages = false, imageCount = 0 } = {}) {
  const errors = {};
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const price = Number(body.price);
  const stockRaw = Number(body.stock);
  const stock = Number.isFinite(stockRaw) ? Math.floor(stockRaw) : NaN;

  if (name.length < 2) errors.name = 'Product name must be at least 2 characters';
  else if (name.length > 120) errors.name = 'Product name is too long';

  if (description.length > 2000) errors.description = 'Description is too long';

  if (!Number.isFinite(price) || price < 0) errors.price = 'Enter a valid price';

  if (!Number.isFinite(stock) || stock < 0) {
    errors.stock = 'Stock must be a whole number 0 or greater';
  }

  if (requireImages && imageCount < 1) {
    errors.images = 'At least one product photo is required';
  }

  return {
    errors,
    name,
    description,
    price: Number.isFinite(price) ? price : 0,
    stock: Number.isFinite(stock) ? stock : 0,
    isActive: parseBool(body.isActive, true),
  };
}

export async function listAdminProducts(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const [rows, total] = await Promise.all([
      Product.find({}).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments({}),
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

export async function getAdminProductById(req, res, next) {
  try {
    const doc = await Product.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Product not found' });
    return res.json(mapProduct(doc));
  } catch (err) {
    next(err);
  }
}

export async function createAdminProduct(req, res, next) {
  try {
    const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
    const parsed = validateProductFields(req.body || {}, { requireImages: true, imageCount: files.length });
    if (Object.keys(parsed.errors).length) {
      return res.status(400).json({ message: 'Please fix the errors below', errors: parsed.errors });
    }

    const maxSort = await Product.findOne({}).sort({ sortOrder: -1 }).select('sortOrder').lean();
    const sortOrder = Number.isFinite(maxSort?.sortOrder) ? maxSort.sortOrder + 1 : 0;

    const productId = new mongoose.Types.ObjectId();
    const imageUrls = await persistProductImages(files, productId.toString());

    const product = await Product.create({
      _id: productId,
      name: parsed.name,
      description: parsed.description,
      price: parsed.price,
      stock: parsed.stock,
      imageUrls,
      sortOrder,
      isActive: parsed.isActive,
    });

    return res.status(201).json(mapProduct(product));
  } catch (err) {
    next(err);
  }
}

export async function patchAdminProduct(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const files = Array.isArray(req.files) ? req.files : req.file ? [req.file] : [];
    const kept = parseKeepImageUrls(req.body, product.imageUrls || []);
    const newUrls = files.length ? await persistProductImages(files, product._id.toString()) : [];
    const imageUrls = [...kept, ...newUrls];

    const parsed = validateProductFields(
      { ...product.toObject(), ...req.body },
      { requireImages: false, imageCount: imageUrls.length },
    );
    if (Object.keys(parsed.errors).length) {
      return res.status(400).json({ message: 'Please fix the errors below', errors: parsed.errors });
    }
    if (imageUrls.length < 1) {
      return res.status(400).json({ message: 'Please fix the errors below', errors: { images: 'At least one product photo is required' } });
    }

    product.name = parsed.name;
    product.description = parsed.description;
    product.price = parsed.price;
    product.stock = parsed.stock;
    product.isActive = parsed.isActive;
    product.imageUrls = imageUrls;

    if (req.body.sortOrder != null && req.body.sortOrder !== '') {
      const n = Number(req.body.sortOrder);
      if (Number.isFinite(n)) product.sortOrder = n;
    }

    await product.save();
    return res.json(mapProduct(product));
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminProductImage(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= (product.imageUrls?.length || 0)) {
      return res.status(400).json({ message: 'Invalid image index' });
    }
    if ((product.imageUrls?.length || 0) <= 1) {
      return res.status(400).json({ message: 'Product must keep at least one photo' });
    }

    product.imageUrls = product.imageUrls.filter((_, i) => i !== index);
    await product.save();
    return res.json(mapProduct(product));
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminProduct(req, res, next) {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    return res.json({ message: 'Product deleted' });
  } catch (err) {
    next(err);
  }
}

export async function reorderAdminProducts(req, res, next) {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ message: 'Provide items to reorder', errors: { items: 'Required' } });
    }

    const ops = items
      .map((row) => {
        const id = String(row?.id || row?._id || '').trim();
        const sortOrder = Number(row?.sortOrder);
        if (!id || !Number.isFinite(sortOrder)) return null;
        return Product.updateOne({ _id: id }, { $set: { sortOrder } });
      })
      .filter(Boolean);

    if (!ops.length) {
      return res.status(400).json({ message: 'Invalid reorder payload', errors: { items: 'Invalid format' } });
    }

    await Promise.all(ops);
    const rows = await Product.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
    return res.json({ data: rows.map(mapProduct) });
  } catch (err) {
    next(err);
  }
}
