import mongoose from 'mongoose';
import Booking from '../models/Booking.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Offline home bookings for admin verification queue (search, status, date range).
 */
export async function listOfflinePaymentsQueue(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : '';

    const baseFilter = {
      serviceType: 'home',
      homePlanPaymentMode: 'offline',
      planStatus: 'approved',
    };

    if (status && ['pending', 'collected', 'verified'].includes(status)) {
      baseFilter['payment.status'] = status;
    }

    if (dateFrom || dateTo) {
      baseFilter.updatedAt = {};
      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        baseFilter.updatedAt.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        baseFilter.updatedAt.$lte = new Date(`${dateTo}T23:59:59.999Z`);
      }
    }

    const userCol = mongoose.model('User').collection.name;
    const physioCol = mongoose.model('Physiotherapist').collection.name;

    const oidSearch =
      search && mongoose.isValidObjectId(search) ? new mongoose.Types.ObjectId(search) : null;

    const pipeline = [
      { $match: baseFilter },
      {
        $lookup: {
          from: userCol,
          localField: 'userId',
          foreignField: '_id',
          as: '_user',
        },
      },
      {
        $lookup: {
          from: physioCol,
          localField: 'physioId',
          foreignField: '_id',
          as: '_physio',
        },
      },
      {
        $addFields: {
          patientName: { $ifNull: [{ $arrayElemAt: ['$_user.name', 0] }, ''] },
          physioName: { $ifNull: [{ $arrayElemAt: ['$_physio.name', 0] }, ''] },
        },
      },
    ];

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const or = [{ patientName: rx }, { physioName: rx }];
      if (oidSearch) or.push({ _id: oidSearch });
      pipeline.push({ $match: { $or: or } });
    }

    pipeline.push({ $sort: { updatedAt: -1 } });

    const countPipeline = [...pipeline, { $count: 'n' }];
    const dataPipeline = [
      ...pipeline,
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          date: 1,
          timeSlot: 1,
          totalAmount: 1,
          payment: 1,
          homePlanPaymentMode: 1,
          paymentStatus: 1,
          offlinePaymentVerified: 1,
          offlinePaymentRejectReason: 1,
          updatedAt: 1,
          createdAt: 1,
          patientName: 1,
          physioName: 1,
          patientPhone: { $arrayElemAt: ['$_user.phone', 0] },
          physioPhone: { $arrayElemAt: ['$_physio.phone', 0] },
        },
      },
    ];

    const [countRows, data] = await Promise.all([
      Booking.aggregate(countPipeline),
      Booking.aggregate(dataPipeline),
    ]);

    const total = countRows[0]?.n ?? 0;

    const queueBase = {
      serviceType: 'home',
      homePlanPaymentMode: 'offline',
      planStatus: 'approved',
    };

    const [countAgg, pendingVerification, allTotal] = await Promise.all([
      Booking.aggregate([
        { $match: queueBase },
        { $group: { _id: '$payment.status', n: { $sum: 1 } } },
      ]),
      Booking.countDocuments({ ...queueBase, 'payment.status': 'collected' }),
      Booking.countDocuments(queueBase),
    ]);

    const counts = { pending: 0, collected: 0, verified: 0, paid: 0, refunded: 0, all: allTotal };
    for (const row of countAgg) {
      const k = row._id;
      if (k === 'pending' || k === 'collected' || k === 'verified' || k === 'paid' || k === 'refunded') {
        counts[k] = row.n;
      }
    }

    return res.json({
      data,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts,
      pendingVerification,
    });
  } catch (err) {
    next(err);
  }
}
