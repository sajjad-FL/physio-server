import { Router } from 'express';
import { getPublicPhysioNda } from '../controllers/platformSettingsController.js';
import { getHomeMarketplaceStats } from '../controllers/marketplaceController.js';
import { getPublicPricingSettingsHandler } from '../controllers/pricingSettingsController.js';

const router = Router();

router.get('/physio-nda', getPublicPhysioNda);
router.get('/home-stats', getHomeMarketplaceStats);
router.get('/pricing-settings', getPublicPricingSettingsHandler);

export default router;
