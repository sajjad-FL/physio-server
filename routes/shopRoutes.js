import { Router } from 'express';
import { requireAuth } from '../middleware/authMiddleware.js';
import { listShopProducts, getShopProductById } from '../controllers/shopProductController.js';
import { getShopCart, upsertShopCartItem, clearShopCart } from '../controllers/shopCartController.js';
import {
  placeShopOrder,
  listPatientShopOrders,
  getPatientShopOrderById,
} from '../controllers/shopOrderController.js';

const router = Router();

router.get('/products', requireAuth, listShopProducts);
router.get('/products/:id', requireAuth, getShopProductById);

router.get('/cart', requireAuth, getShopCart);
router.put('/cart/items', requireAuth, upsertShopCartItem);
router.delete('/cart', requireAuth, clearShopCart);

router.post('/orders', requireAuth, placeShopOrder);
router.get('/orders', requireAuth, listPatientShopOrders);
router.get('/orders/:id', requireAuth, getPatientShopOrderById);

export default router;
