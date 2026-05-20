import mongoose from 'mongoose';
import 'dotenv/config';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  const maskedUri = uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@]+@/i, '$1*****:*****@');
  console.log('Connecting to MongoDB at', maskedUri);
  await mongoose.connect(uri);
}
