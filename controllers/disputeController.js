import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Dispute from '../models/Dispute.js';
import Physiotherapist from '../models/Physiotherapist.js';
import { isPhysioPlatformApproved } from '../utils/physioVerification.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 10));
  return { page, limit, skip: (page - 1) * limit };
}

export async function raiseDispute(req, res, next) {
  try {
    const { bookingId, reason, description } = req.body || {};
    if (!mongoose.isValidObjectId(bookingId)) {
      return res.status(400).json({ message: 'Invalid bookingId' });
    }
    if (!String(reason || '').trim()) {
      return res.status(400).json({ message: 'reason is required' });
    }
    if (!String(description || '').trim()) {
      return res.status(400).json({ message: 'description is required' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: 'Booking not found' });

    const ctx = req.auth;
    if (!ctx) return res.status(401).json({ message: 'Unauthorized' });

    const canAsUser =
      ctx.role === 'user' && booking.userId?.toString() === ctx.userId;
    const canAsPhysio =
      ctx.role === 'physio' &&
      ctx.physioId &&
      booking.physioId?.toString() === ctx.physioId;

    let raisedBy;
    let raiserUserId = null;
    let raiserPhysioId = null;
    if (canAsUser) {
      raisedBy = 'user';
      raiserUserId = ctx.userId;
    } else if (canAsPhysio) {
      const physioDoc = await Physiotherapist.findById(ctx.physioId).lean();
      if (!isPhysioPlatformApproved(physioDoc)) {
        return res.status(403).json({
          message: 'Your profile is under approval',
          code: 'PHYSIO_PENDING',
        });
      }
      raisedBy = 'physio';
      raiserPhysioId = ctx.physioId;
    } else {
      return res.status(403).json({ message: 'You cannot dispute this booking' });
    }

    const open = await Dispute.findOne({
      bookingId,
      status: { $in: ['open', 'under_review'] },
    })
      .select('_id')
      .lean();
    if (open) {
      return res.status(409).json({ message: 'An open dispute already exists for this booking' });
    }

    const created = await Dispute.create({
      bookingId,
      raisedBy,
      raiserUserId,
      raiserPhysioId,
      reason: String(reason).trim(),
      description: String(description).trim(),
      status: 'open',
      resolution: '',
    });

    const populated = await Dispute.findById(created._id)
      .populate({
        path: 'bookingId',
        select:
          'date timeSlot issue paymentStatus sessionStatus status userId physioId',
        populate: [
          { path: 'userId', select: 'name phone' },
          { path: 'physioId', select: 'name phone specialization' },
        ],
      })
      .lean();

    return res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
}

export async function listMyDisputes(req, res, next) {
  try {
    const ctx = req.auth;
    if (!ctx) return res.status(401).json({ message: 'Unauthorized' });

    const sets = [];
    if (ctx.role === 'user') {
      sets.push(await Booking.find({ userId: ctx.userId }).distinct('_id'));
    }
    if (ctx.role === 'physio' && ctx.physioId) {
      const physioDoc = await Physiotherapist.findById(ctx.physioId).lean();
      if (isPhysioPlatformApproved(physioDoc)) {
        sets.push(await Booking.find({ physioId: ctx.physioId }).distinct('_id'));
      }
    }
    const bookingIds = [...new Set(sets.flat())];

    const { page, limit, skip } = readPagination(req.query);
    const query = { bookingId: { $in: bookingIds } };
    const [list, total] = await Promise.all([
      Dispute.find(query)
      .populate({
        path: 'bookingId',
        select:
          'date timeSlot issue paymentStatus sessionStatus status userId physioId',
        populate: [
          { path: 'userId', select: 'name phone' },
          { path: 'physioId', select: 'name phone specialization' },
        ],
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
      Dispute.countDocuments(query),
    ]);

    return res.json({
      data: list,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
}
