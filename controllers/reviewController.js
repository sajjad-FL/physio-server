import mongoose from 'mongoose';
import Review from '../models/Review.js';
import Booking from '../models/Booking.js';
import Physiotherapist from '../models/Physiotherapist.js';

export async function syncPhysioReviewAggregates(physioId) {
  const pid = new mongoose.Types.ObjectId(physioId);
  const [row] = await Review.aggregate([
    { $match: { physioId: pid } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  const avgRating = row && Number.isFinite(row.avg) ? Math.round(row.avg * 10) / 10 : 0;
  const totalReviews = row ? row.count : 0;
  await Physiotherapist.findByIdAndUpdate(physioId, { $set: { avgRating, totalReviews } });
}

export async function createReview(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { bookingId, sessionId: sessionIdRaw, rating: ratingRaw, comment } = req.body || {};
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Valid bookingId is required' });
    }

    const rating = Number(ratingRaw);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'rating must be an integer from 1 to 5' });
    }

    const text = comment != null ? String(comment).trim().slice(0, 2000) : '';

    const booking = await Booking.findById(bookingId).lean();
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (String(booking.userId) !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (!booking.physioId) {
      return res.status(400).json({ message: 'No physiotherapist assigned to this booking' });
    }

    let sessionId = null;
    if (sessionIdRaw != null && String(sessionIdRaw).length > 0) {
      if (!mongoose.isValidObjectId(sessionIdRaw)) {
        return res.status(400).json({ message: 'Invalid sessionId' });
      }
      sessionId = new mongoose.Types.ObjectId(String(sessionIdRaw));
      const entry = (booking.schedule || []).find(
        (s) => String(s._id) === String(sessionId),
      );
      if (!entry) {
        return res.status(404).json({ message: 'Session not found on this booking' });
      }
      if (entry.status !== 'completed') {
        return res
          .status(400)
          .json({ message: 'You can only rate a session after it is marked completed' });
      }
    } else if (booking.sessionStatus !== 'completed' || booking.status !== 'completed') {
      return res
        .status(400)
        .json({ message: 'You can only review after the session is completed' });
    }

    const existing = await Review.findOne({ bookingId, sessionId }).lean();
    if (existing) {
      return res
        .status(400)
        .json({ message: 'You have already reviewed this session' });
    }

    const review = await Review.create({
      physioId: booking.physioId,
      userId,
      bookingId,
      sessionId,
      rating,
      comment: text,
    });

    await syncPhysioReviewAggregates(booking.physioId);

    return res.status(201).json(review.toObject());
  } catch (err) {
    next(err);
  }
}

export async function listMyReviewsForBooking(req, res, next) {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const { bookingId } = req.params;
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid booking id' });
    }

    const booking = await Booking.findById(bookingId).select('userId').lean();
    if (!booking) {
      return res.status(404).json({ message: 'Booking not found' });
    }
    if (String(booking.userId) !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const reviews = await Review.find({ bookingId, userId })
      .select('sessionId rating comment createdAt')
      .sort({ createdAt: 1 })
      .lean();

    return res.json({
      data: reviews.map((r) => ({
        _id: String(r._id),
        sessionId: r.sessionId ? String(r.sessionId) : null,
        rating: r.rating,
        comment: r.comment || '',
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

export async function listPhysioReviews(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid physiotherapist id' });
    }

    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const physio = await Physiotherapist.findOne({
      _id: id,
      verificationStatus: 'approved',
      isVerified: true,
    })
      .select('_id')
      .lean();
    if (!physio) {
      return res.status(404).json({ message: 'Physiotherapist not found' });
    }

    const [list, total] = await Promise.all([
      Review.find({ physioId: id })
        .populate('userId', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Review.countDocuments({ physioId: id }),
    ]);

    return res.json({
      data: list.map((r) => ({
        _id: r._id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        user: { name: r.userId?.name || 'Patient' },
      })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}
