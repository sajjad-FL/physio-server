import { Router } from 'express';
import { getPhysioSitemapXml } from '../controllers/seoController.js';

const router = Router();

router.get('/physio-sitemap.xml', getPhysioSitemapXml);

export default router;
