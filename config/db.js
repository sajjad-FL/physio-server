import mongoose from 'mongoose';
import 'dotenv/config';

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  console.log('Connecting to MongoDB at', uri);
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  await mongoose.connect(uri);
}
