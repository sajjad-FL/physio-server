import mongoose from 'mongoose';

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '', maxlength: 2000 },
    price: { type: Number, required: true, min: 0 },
    imageUrls: { type: [String], default: [] },
    stock: { type: Number, default: 0, min: 0 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

productSchema.index({ isActive: 1, sortOrder: 1 });

export default mongoose.model('Product', productSchema);
