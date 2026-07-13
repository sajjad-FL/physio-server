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

function sessionOrdinalFromSchedule(sessionId, schedule) {
  if (!sessionId || !Array.isArray(schedule)) return null;
  const idx = schedule.findIndex((s) => String(s._id) === String(sessionId));
  return idx >= 0 ? idx + 1 : null;
}

function shapeQueueRow(row) {
  const schedule = row.bookingSchedule;
  const sessionOrdinal = sessionOrdinalFromSchedule(row.sessionId, schedule);
  const { bookingSchedule, ...rest } = row;
  return { ...rest, sessionOrdinal };
}

function parseAmountBound(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Per-installment admin payment history / queue.
 * Filters: mode, channel, collector, status, date range, amount min/max, search.
 */
export async function listPaymentsQueue(req, res, next) {
  try {
    const { page, limit, skip } = readPagination(req.query);
    const mode = String(req.query.mode || '').trim();
    const channel = String(req.query.channel || '').trim().toLowerCase();
    const collector = String(req.query.collector || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim();
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : '';
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : '';
    const search = String(req.query.search || '').trim();
    const amountMin = parseAmountBound(req.query.amountMin);
    const amountMax = parseAmountBound(req.query.amountMax);

    const baseFilter = {};
    if (mode === 'online' || mode === 'offline') baseFilter.mode = mode;
    if (PAYMENT_STATUSES.includes(status)) baseFilter.status = status;

    if (channel === 'online') {
      baseFilter.mode = 'online';
    } else if (channel === 'phonepe_qr') {
      baseFilter['meta.collectionChannel'] = 'phonepe_qr';
    } else if (channel === 'cash') {
      baseFilter.mode = 'offline';
      baseFilter['meta.collectionChannel'] = { $ne: 'phonepe_qr' };
    }

    if (collector === 'manager') {
      baseFilter['meta.managerId'] = { $exists: true, $nin: [null, ''] };
    } else if (collector === 'physio') {
      baseFilter.$and = [
        ...(baseFilter.$and || []),
        {
          $or: [
            { 'meta.managerId': { $exists: false } },
            { 'meta.managerId': null },
            { 'meta.managerId': '' },
          ],
        },
      ];
    }

    if (amountMin != null || amountMax != null) {
      baseFilter.amount = {};
      if (amountMin != null) baseFilter.amount.$gte = amountMin;
      if (amountMax != null) baseFilter.amount.$lte = amountMax;
    }

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
          patientPhone: { $ifNull: [{ $arrayElemAt: ['$_user.phone', 0] }, ''] },
          physioName: { $ifNull: [{ $arrayElemAt: ['$_physio.name', 0] }, ''] },
          physioPhone: { $ifNull: [{ $arrayElemAt: ['$_physio.phone', 0] }, ''] },
          bookingTotal: { $arrayElemAt: ['$_booking.totalAmount', 0] },
          bookingServiceType: { $arrayElemAt: ['$_booking.serviceType', 0] },
          bookingIssue: { $ifNull: [{ $arrayElemAt: ['$_booking.issue', 0] }, ''] },
          bookingDate: { $arrayElemAt: ['$_booking.date', 0] },
          bookingTimeSlot: { $arrayElemAt: ['$_booking.timeSlot', 0] },
          bookingSchedule: { $arrayElemAt: ['$_booking.schedule', 0] },
          bookingCode: { $ifNull: [{ $arrayElemAt: ['$_booking.bookingCode', 0] }, ''] },
          managerIdRaw: { $ifNull: ['$meta.managerId', null] },
          collectionChannel: { $ifNull: ['$meta.collectionChannel', ''] },
        },
      },
      {
        $lookup: {
          from: userCol,
          let: { mid: '$managerIdRaw' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: [
                    '$_id',
                    {
                      $convert: {
                        input: '$$mid',
                        to: 'objectId',
                        onError: null,
                        onNull: null,
                      },
                    },
                  ],
                },
              },
            },
            { $project: { name: 1, phone: 1 } },
          ],
          as: '_manager',
        },
      },
      {
        $addFields: {
          managerName: { $ifNull: [{ $arrayElemAt: ['$_manager.name', 0] }, ''] },
          managerPhone: { $ifNull: [{ $arrayElemAt: ['$_manager.phone', 0] }, ''] },
        },
      },
    ];

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      const or = [
        { patientName: rx },
        { patientPhone: rx },
        { physioName: rx },
        { physioPhone: rx },
        { bookingIssue: rx },
        { managerName: rx },
        { managerPhone: rx },
        { bookingCode: rx },
        { note: rx },
      ];
      if (oidSearch) {
        or.push({ _id: oidSearch });
        or.push({ bookingId: oidSearch });
      }
      pipeline.push({ $match: { $or: or } });
    }

    pipeline.push({ $sort: { createdAt: -1 } });

    const countPipeline = [...pipeline, { $count: 'n' }];
    const sumPipeline = [
      ...pipeline,
      {
        $group: {
          _id: null,
          sum: { $sum: '$amount' },
          n: { $sum: 1 },
        },
      },
    ];
    const dataPipeline = [
      ...pipeline,
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          bookingId: 1,
          sessionId: 1,
          amount: 1,
          mode: 1,
          status: 1,
          collectedAt: 1,
          verifiedAt: 1,
          createdAt: 1,
          rejectReason: 1,
          razorpayPaymentId: 1,
          note: 1,
          proofUrl: 1,
          meta: 1,
          patientName: 1,
          patientPhone: 1,
          physioName: 1,
          physioPhone: 1,
          managerName: 1,
          managerPhone: 1,
          bookingTotal: 1,
          bookingServiceType: 1,
          bookingIssue: 1,
          bookingDate: 1,
          bookingTimeSlot: 1,
          bookingSchedule: 1,
          bookingCode: 1,
          collectionChannel: 1,
        },
      },
    ];

    const [countRows, data, sumRows, countAgg, pendingVerification, allTotal] = await Promise.all([
      Payment.aggregate(countPipeline),
      Payment.aggregate(dataPipeline),
      Payment.aggregate(sumPipeline),
      Payment.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      Payment.countDocuments({ mode: 'offline', status: 'collected' }),
      Payment.countDocuments({}),
    ]);

    const total = countRows[0]?.n ?? 0;
    const filteredAmountSum = Number(sumRows[0]?.sum) || 0;
    const counts = { pending: 0, paid: 0, collected: 0, verified: 0, rejected: 0, refunded: 0, all: allTotal };
    for (const row of countAgg) {
      if (PAYMENT_STATUSES.includes(row._id)) counts[row._id] = row.n;
    }

    return res.json({
      data: data.map(shapeQueueRow),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts,
      pendingVerification,
      filteredAmountSum,
      filters: {
        mode,
        channel,
        collector,
        status,
        dateFrom,
        dateTo,
        amountMin,
        amountMax,
        search,
      },
    });
  } catch (err) {
    next(err);
  }
}
