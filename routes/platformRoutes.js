import { Router } from 'express';
import { getPublicPhysioNda } from '../controllers/platformSettingsController.js';
import { getHomeMarketplaceStats } from '../controllers/marketplaceController.js';

const router = Router();

router.get('/physio-nda', getPublicPhysioNda);
router.get('/home-stats', getHomeMarketplaceStats);

export default router;
