import Physiotherapist from '../models/Physiotherapist.js';

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Sitemap of public physician profile URLs (same eligibility as getPublicPhysioProfile).
 * Set PUBLIC_CLIENT_ORIGIN to your deployed SPA origin (no trailing slash), e.g. https://www.example.com
 */
export async function getPhysioSitemapXml(_req, res, next) {
  try {
    const base = String(process.env.PUBLIC_CLIENT_ORIGIN || 'http://localhost:5173')
      .trim()
      .replace(/\/$/, '');
    const ids = await Physiotherapist.find({
      verificationStatus: 'approved',
      isVerified: true,
    })
      .select('_id updatedAt')
      .lean();
    const now = new Date().toISOString().slice(0, 10);
    const lines = ids.map(({ _id, updatedAt }) => {
      const loc = `${base}/physician/${_id}`;
      const lastmod =
        updatedAt instanceof Date ? updatedAt.toISOString().slice(0, 10) : now;
      return `  <url><loc>${escapeXml(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>`;
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${lines.join('\n')}
</urlset>
`;
    res.type('application/xml').send(xml);
  } catch (err) {
    next(err);
  }
}
