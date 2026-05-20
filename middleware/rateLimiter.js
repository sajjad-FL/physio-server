import { rateLimit } from 'express-rate-limit';

/**
 * General rate limiter for authentication routes (login, register, etc.).
 * Limits each IP to 100 requests per 15 minutes.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    message: 'Too many requests from this IP. Please try again after 15 minutes.'
  }
});

/**
 * Strict rate limiter for sensitive password-reset / forgot-password endpoints.
 * Limits each IP to 5 requests per 15 minutes.
 */
export const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    message: 'Too many password reset requests. Please try again after 15 minutes.'
  }
});
