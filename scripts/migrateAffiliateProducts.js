import 'dotenv/config';
import { connectDB } from '../config/db.js';
import Product from '../models/Product.js';

async function main() {
  await connectDB();
  const legacy = await Product.find({
    $or: [
      { externalUrl: { $exists: true } },
      { imageUrl: { $exists: true } },
      { vendor: { $exists: true } },
      { imageUrls: { $exists: false } },
      { price: { $exists: false } },
    ],
  }).lean();

  if (!legacy.length) {
    console.log('No legacy affiliate products to migrate.');
    process.exit(0);
  }

  const result = await Product.updateMany(
    {
      $or: [
        { externalUrl: { $exists: true } },
        { imageUrl: { $exists: true } },
        { vendor: { $exists: true } },
      ],
    },
    {
      $set: { isActive: false },
      $unset: { externalUrl: '', imageUrl: '', vendor: '' },
    },
  );

  console.log(`Marked ${result.modifiedCount} legacy affiliate product(s) inactive and removed affiliate fields.`);
  console.log('Re-create products in admin with price, stock, and images.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
