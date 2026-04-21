import mongoose from 'mongoose';
import Payment from '../models/Payment.js';

function readPagination(query) {
  const page = Math.max(1, Number(query?.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query?.limit) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PAYMENT_STATUSES = ['pending', 'paid', 'collected', 'verified', 'rejected', 'refunded'];

/**
 * Per-installment admin queue: one row per Payment document. Supports filtering
 * by mode, status, date range, and searching across physio/patient names and
 * booking ids. Admin verifies/rejects offline collections from this list.
 */
export async function listPaymentsQueue(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const mode = String(req.query.mode || '').trim();
    const status = String(req.query.status || '').trim();
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : '';
    const search = String(req.query.search || '').trim();

    const baseFilter = {};
    if (mode === 'online' || mode === 'offline') baseFilter.mode = mode;
    if (PAYMENT_STATUSES.includes(status)) baseFilter.status = status;

    if (dateFrom || dateTo) {
      baseFilter.createdAt = {};
      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        baseFilter.createdAt.$gte = new Date(`${dateFrom}T00:00:00.000Z`);
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        baseFilter.createdAt.$lte = new Date(`${dateTo}T23:59:59.999Z`);
      }
    }

    const userCol = mongoose.model('User').collection.name;
    const physioCol = mongoose.model('Physiotherapist').collection.name;
    const bookingCol = mongoose.model('Booking').collection.name;

    const oidSearch =
      search && mongoose.isValidObjectId(search) ? new mongoose.Types.ObjectId(search) : null;

    const pipeline = [
      { $match: baseFilter },
      {
        $lookup: {
          from: bookingCol,
          localField: 'bookingId',
          foreignField: '_id',
          as: '_booking',
        },
      },
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
          patientPhone: { $arrayElemAt: ['$_user.phone', 0] },
          physioName: { $ifNull: [{ $arrayElemAt: ['$_physio.name', 0] }, ''] },
          physioPhone: { $arrayElemAt: ['$_physio.phone', 0] },
          bookingTotal: { $arrayElemAt: ['$_booking.totalAmount', 0] },
          bookingServiceType: { $arrayElemAt: ['$_booking.serviceType', 0] },
        },
      },
    ];

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const or = [{ patientName: rx }, { physioName: rx }];
      if (oidSearch) {
        or.push({ _id: oidSearch });
        or.push({ bookingId: oidSearch });
      }
      pipeline.push({ $match: { $or: or } });
    }

    pipeline.push({ $sort: { createdAt: -1 } });

    const countPipeline = [...pipeline, { $count: 'n' }];
    const dataPipeline = [
      ...pipeline,
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          bookingId: 1,
          amount: 1,
          mode: 1,
          status: 1,
          collectedAt: 1,
          verifiedAt: 1,
          createdAt: 1,
          rejectReason: 1,
          razorpayPaymentId: 1,
          note: 1,
          patientName: 1,
          patientPhone: 1,
          physioName: 1,
          physioPhone: 1,
          bookingTotal: 1,
          bookingServiceType: 1,
        },
      },
    ];

    const [countRows, data, countAgg, pendingVerification, allTotal] = await Promise.all([
      Payment.aggregate(countPipeline),
      Payment.aggregate(dataPipeline),
      Payment.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      Payment.countDocuments({ mode: 'offline', status: 'collected' }),
      Payment.countDocuments({}),
    ]);

    const total = countRows[0]?.n ?? 0;
    const counts = { pending: 0, paid: 0, collected: 0, verified: 0, rejected: 0, refunded: 0, all: allTotal };
    for (const row of countAgg) {
      if (PAYMENT_STATUSES.includes(row._id)) counts[row._id] = row.n;
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
