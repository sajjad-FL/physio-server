import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let client = null;
let clientKey = '';

function readS3Config() {
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
  const bucket = process.env.AWS_S3_BUCKET || '';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
  const publicBase = (process.env.AWS_S3_PUBLIC_URL || '').replace(/\/$/, '');
  return { region, bucket, accessKeyId, secretAccessKey, publicBase };
}

function getClient() {
  const { region, accessKeyId, secretAccessKey } = readS3Config();
  const nextClientKey = `${region}|${accessKeyId ? 'ak' : 'role'}`;
  if (!client && isS3Configured()) {
    client = new S3Client({
      region,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: { accessKeyId, secretAccessKey },
          }
        : {}),
    });
    clientKey = nextClientKey;
  } else if (client && clientKey !== nextClientKey) {
    client = new S3Client({
      region,
      ...(accessKeyId && secretAccessKey
        ? {
            credentials: { accessKeyId, secretAccessKey },
          }
        : {}),
    });
    clientKey = nextClientKey;
  }
  return client;
}

/**
 * S3 uploads are enabled when bucket and region are set.
 * Credentials use the default AWS provider chain (env keys, shared config, IAM role).
 */
export function isS3Configured() {
  const { bucket, region } = readS3Config();
  return Boolean(bucket && region);
}

function sanitizeFilename(name) {
  const base = String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 180) || 'file';
}

/**
 * @param {Buffer} buffer
 * @param {string} key - S3 object key (e.g. physio/abc/degree.pdf)
 * @param {string} [contentType]
 * @returns {Promise<string>} Public HTTPS URL stored in the database
 */
export async function uploadBufferToS3(buffer, key, contentType = 'application/octet-stream') {
  const c = getClient();
  const { bucket } = readS3Config();
  if (!c) {
    throw new Error('S3 is not configured (set AWS_S3_BUCKET and AWS_REGION)');
  }
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
  return publicUrlForKey(key);
}

/**
 * @param {Buffer} buffer
 * @param {string} folderPrefix - e.g. physio/{physioId}
 * @param {string} originalName
 * @param {string} [contentType]
 */
export async function uploadPhysioAsset(buffer, folderPrefix, originalName, contentType) {
  const safe = sanitizeFilename(originalName);
  const key = `${folderPrefix.replace(/\/$/, '')}/${Date.now()}-${safe}`;
  return uploadBufferToS3(buffer, key, contentType || 'application/octet-stream');
}

function publicUrlForKey(key) {
  const { bucket, region, publicBase } = readS3Config();
  if (publicBase) {
    return `${publicBase}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }
  return `https://${bucket}.s3.${region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export { sanitizeFilename };
