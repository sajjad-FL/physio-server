import mongoose from 'mongoose';

export const SHOP_ORDER_STATUSES = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'];

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    imageUrl: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const addressSchema = new mongoose.Schema(
  {
    text: { type: String, trim: true, default: '' },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { _id: false },
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, enum: SHOP_ORDER_STATUSES, required: true },
    at: { type: Date, default: () => new Date() },
    byRole: { type: String, trim: true, default: 'system' },
    note: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const shopOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    items: { type: [orderItemSchema], required: true },
    shippingAddress: { type: addressSchema, default: () => ({}) },
    customerPhone: { type: String, trim: true, default: '' },
    customerName: { type: String, trim: true, default: '' },
    subtotal: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, enum: ['cod'], default: 'cod' },
    status: { type: String, enum: SHOP_ORDER_STATUSES, default: 'placed', index: true },
    statusHistory: { type: [statusHistorySchema], default: [] },
    cancelReason: { type: String, trim: true, default: '' },
    patientNote: { type: String, trim: true, default: '', maxlength: 500 },
  },
  { timestamps: true },
);

export default mongoose.model('ShopOrder', shopOrderSchema);
