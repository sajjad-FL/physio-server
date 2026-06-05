import mongoose from 'mongoose';
import 'dotenv/config';
import dns from 'node:dns';

function ensureSrvDnsResolver(uri) {
  if (!uri.startsWith('mongodb+srv://')) return;

  const servers = dns.getServers();
  const usesLoopbackDns = servers.some((server) =>
    /^(127\.|0\.0\.0\.0|::1$|localhost$)/i.test(server)
  );
  if (!usesLoopbackDns) return;

  const fallbackServers = (process.env.MONGODB_DNS_SERVERS || '8.8.8.8,1.1.1.1')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
  if (fallbackServers.length > 0) {
    dns.setServers(fallbackServers);
  }
}

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  ensureSrvDnsResolver(uri);
  const maskedUri = uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@]+@/i, '$1*****:*****@');
  console.log('Connecting to MongoDB at', maskedUri);
  await mongoose.connect(uri);
}
