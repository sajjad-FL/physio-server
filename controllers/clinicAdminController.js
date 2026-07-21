import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Clinic from '../models/Clinic.js';
import ClinicLedgerEntry from '../models/ClinicLedgerEntry.js';
import ClinicSettlementBatch from '../models/ClinicSettlementBatch.js';
import User from '../models/User.js';
import Transaction from '../models/Transaction.js';
import {
  distributeClinicSettlementBatch,
  previewClinicDistribution,
} from '../services/clinicSettlement.js';
import { assignClinicToBookingCore } from './clinicController.js';
import { readPagination, paginationMeta } from '../utils/pagination.js';

function roundMoney2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export async function listClinics(req, res, next) {
  try {
    const activeOnly = String(req.query?.active || '') === '1' || String(req.query?.active || '') === 'true';
    const filter = activeOnly ? { isActive: true } : {};
    const clinics = await Clinic.find(filter)
      .populate('staffUserIds', 'name phone role')
      .populate('walletUserId', 'name phone')
      .populate('physioIds', 'name specialization phone')
      .sort({ name: 1 })
      .lean();
    return res.json({ clinics });
  } catch (err) {
    next(err);
  }
}

export async function createClinic(req, res, next) {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required' });

    const clinic = await Clinic.create({
      name,
      address: String(body.address || '').trim(),
      pincode: body.pincode ? String(body.pincode).trim() : null,
      phone: String(body.phone || '').trim(),
      coordinates: body.coordinates || null,
      physioIds: Array.isArray(body.physioIds) ? body.physioIds : [],
      staffUserIds: Array.isArray(body.staffUserIds) ? body.staffUserIds : [],
      walletUserId: body.walletUserId || null,
      isActive: body.isActive !== false,
      payoutUpiId: String(body.payoutUpiId || '').trim(),
      payoutDisplayName: String(body.payoutDisplayName || '').trim(),
    });
    return res.status(201).json({ clinic });
  } catch (err) {
    next(err);
  }
}

export async function updateClinic(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid clinic id' });
    }
    const clinic = await Clinic.findById(id);
    if (!clinic) return res.status(404).json({ message: 'Clinic not found' });

    const body = req.body || {};
    if (body.name != null) clinic.name = String(body.name).trim();
    if (body.address != null) clinic.address = String(body.address).trim();
    if (body.pincode != null) clinic.pincode = String(body.pincode).trim() || null;
    if (body.phone != null) clinic.phone = String(body.phone).trim();
    if (body.coordinates !== undefined) clinic.coordinates = body.coordinates;
    if (Array.isArray(body.physioIds)) clinic.physioIds = body.physioIds;
    if (Array.isArray(body.staffUserIds)) clinic.staffUserIds = body.staffUserIds;
    if (body.walletUserId !== undefined) clinic.walletUserId = body.walletUserId || null;
    if (typeof body.isActive === 'boolean') clinic.isActive = body.isActive;
    if (body.payoutUpiId != null) clinic.payoutUpiId = String(body.payoutUpiId).trim();
    if (body.payoutDisplayName != null) clinic.payoutDisplayName = String(body.payoutDisplayName).trim();

    await clinic.save();
    return res.json({ clinic });
  } catch (err) {
    next(err);
  }
}

export async function promoteToClinicStaff(req, res, next) {
  try {
    const { userId, clinicId } = req.body || {};
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }
    if (!mongoose.isValidObjectId(clinicId)) {
      return res.status(400).json({ message: 'Invalid clinic id' });
    }

    const clinic = await Clinic.findById(clinicId);
    if (!clinic) return res.status(404).json({ message: 'Clinic not found' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === 'admin') {
      return res.status(400).json({ message: 'Cannot change admin role' });
    }

    user.role = 'clinic_staff';
    user.clinicId = clinic._id;
    await user.save();

    if (!clinic.staffUserIds.some((id) => String(id) === String(user._id))) {
      clinic.staffUserIds.push(user._id);
    }
    if (!clinic.walletUserId) clinic.walletUserId = user._id;
    await clinic.save();

    return res.json({
      user: { _id: user._id, name: user.name, phone: user.phone, role: user.role, clinicId: user.clinicId },
      clinic,
    });
  } catch (err) {
    next(err);
  }
}

export async function adminAssignClinic(req, res, next) {
  try {
    const { id } = req.params;
    const { clinicId } = req.body || {};
    const existing = await Booking.findById(id).select('clinicSource').lean();
    const clinicSource =
      existing?.clinicSource === 'manager_referred' ? 'manager_referred' : 'direct';
    const result = await assignClinicToBookingCore({
      bookingId: id,
      clinicId,
      assignedBy: req.user.id,
      clinicSource,
      requireManagerId: false,
      adminAssign: true,
    });
    if (result.error) {
      return res.status(result.error.status).json({ message: result.error.message });
    }
    return res.json(result.booking);
  } catch (err) {
    next(err);
  }
}

export async function managerAssignClinic(req, res, next) {
  try {
    const { id } = req.params;
    const { clinicId } = req.body || {};
    const result = await assignClinicToBookingCore({
      bookingId: id,
      clinicId,
      assignedBy: req.user.id,
      clinicSource: 'manager_referred',
      requireManagerId: true,
    });
    if (result.error) {
      return res.status(result.error.status).json({ message: result.error.message });
    }
    return res.json(result.booking);
  } catch (err) {
    next(err);
  }
}

export async function getClinicLedgerAdmin(req, res, next) {
  try {
    const { clinicId } = req.params;
    if (!mongoose.isValidObjectId(clinicId)) {
      return res.status(400).json({ message: 'Invalid clinic id' });
    }
    const clinic = await Clinic.findById(clinicId).lean();
    if (!clinic) return res.status(404).json({ message: 'Clinic not found' });

    const status = String(req.query?.status || '').trim();
    const { page, limit, skip } = readPagination(req.query, { defaultLimit: 10, maxLimit: 50 });
    const filter = { clinicId };
    if (status) filter.status = status;

    const [entries, total] = await Promise.all([
      ClinicLedgerEntry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: 'bookingId',
          select: 'issue date timeSlot totalAmount userId bookingCode clinicSource managerId',
          populate: { path: 'userId', select: 'name phone' },
        })
        .lean(),
      ClinicLedgerEntry.countDocuments(filter),
    ]);

    const openTotalAgg = await ClinicLedgerEntry.aggregate([
      {
        $match: {
          clinicId: new mongoose.Types.ObjectId(String(clinicId)),
          status: 'open',
          direction: 'credit',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const openTotal = roundMoney2(openTotalAgg[0]?.total || 0);

    const pendingEntries = await ClinicLedgerEntry.find({
      clinicId,
      status: { $in: ['open', 'batched'] },
      direction: 'credit',
    }).lean();
    const pendingPreview = await previewClinicDistribution(pendingEntries);

    const walletUserId = clinic.walletUserId || clinic.staffUserIds?.[0];
    let settledCommission = 0;
    if (walletUserId) {
      const rows = await Transaction.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(String(walletUserId)),
            type: 'clinic_commission',
            direction: 'credit',
            status: 'posted',
          },
        },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]);
      settledCommission = roundMoney2(rows[0]?.total || 0);
    }

    const batches = await ClinicSettlementBatch.find({ clinicId })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.json({
      clinic,
      entries,
      openTotal,
      pendingPreview,
      settledCommission,
      batches,
      ...paginationMeta({ page, limit, total }),
    });
  } catch (err) {
    next(err);
  }
}

export async function createClinicSettlementBatch(req, res, next) {
  try {
    const { clinicId } = req.params;
    if (!mongoose.isValidObjectId(clinicId)) {
      return res.status(400).json({ message: 'Invalid clinic id' });
    }
    const clinic = await Clinic.findById(clinicId).lean();
    if (!clinic) return res.status(404).json({ message: 'Clinic not found' });

    const entryIds = Array.isArray(req.body?.ledgerEntryIds) ? req.body.ledgerEntryIds : [];
    const notes = String(req.body?.notes || '').trim();

    let entries;
    if (entryIds.length) {
      entries = await ClinicLedgerEntry.find({
        _id: { $in: entryIds },
        clinicId,
        status: 'open',
        direction: 'credit',
      });
    } else {
      entries = await ClinicLedgerEntry.find({
        clinicId,
        status: 'open',
        direction: 'credit',
      });
    }
    if (!entries.length) {
      return res.status(400).json({ message: 'No open ledger entries to batch' });
    }

    const expectedAmount = roundMoney2(entries.reduce((s, e) => s + Number(e.amount || 0), 0));
    const batch = await ClinicSettlementBatch.create({
      clinicId,
      ledgerEntryIds: entries.map((e) => e._id),
      expectedAmount,
      settledAmount: expectedAmount,
      notes,
      status: 'open',
    });

    await ClinicLedgerEntry.updateMany(
      { _id: { $in: entries.map((e) => e._id) } },
      { $set: { status: 'batched', settlementBatchId: batch._id } },
    );

    return res.status(201).json({ batch });
  } catch (err) {
    next(err);
  }
}

export async function listClinicSettlementBatches(req, res, next) {
  try {
    const filter = {};
    if (req.query?.clinicId && mongoose.isValidObjectId(req.query.clinicId)) {
      filter.clinicId = req.query.clinicId;
    }
    const status = String(req.query?.status || '').trim();
    if (status) filter.status = status;

    const batches = await ClinicSettlementBatch.find(filter)
      .populate('clinicId', 'name phone')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const shaped = await Promise.all(
      batches.map(async (batch) => {
        const entries = await ClinicLedgerEntry.find({ _id: { $in: batch.ledgerEntryIds || [] } }).lean();
        const distributionPreview =
          batch.status === 'open' ? await previewClinicDistribution(entries) : null;
        return { ...batch, entryCount: entries.length, distributionPreview };
      }),
    );

    return res.json({ batches: shaped });
  } catch (err) {
    next(err);
  }
}

export async function settleClinicBatch(req, res, next) {
  try {
    const { batchId } = req.params;
    if (!mongoose.isValidObjectId(batchId)) {
      return res.status(400).json({ message: 'Invalid batch id' });
    }
    const batch = await ClinicSettlementBatch.findById(batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    if (batch.status === 'settled') {
      return res.json({ batch, message: 'Already settled' });
    }
    if (batch.status === 'disputed') {
      return res.status(400).json({ message: 'Disputed batch cannot be settled' });
    }

    const totals = await distributeClinicSettlementBatch(batch);
    batch.status = 'settled';
    batch.settledBy = req.user.id;
    batch.settledAt = new Date();
    batch.distributedAt = new Date();
    batch.clinicCommissionTotal = totals.clinicCommissionTotal;
    batch.managerCommissionTotal = totals.managerCommissionTotal;
    await batch.save();

    await ClinicLedgerEntry.updateMany(
      { _id: { $in: batch.ledgerEntryIds || [] } },
      { $set: { status: 'settled' } },
    );

    return res.json({ batch, totals });
  } catch (err) {
    next(err);
  }
}

export async function disputeClinicBatch(req, res, next) {
  try {
    const { batchId } = req.params;
    if (!mongoose.isValidObjectId(batchId)) {
      return res.status(400).json({ message: 'Invalid batch id' });
    }
    const batch = await ClinicSettlementBatch.findById(batchId);
    if (!batch) return res.status(404).json({ message: 'Batch not found' });
    if (batch.status === 'settled') {
      return res.status(400).json({ message: 'Settled batch cannot be disputed' });
    }
    batch.status = 'disputed';
    batch.notes = [batch.notes, String(req.body?.notes || '').trim()].filter(Boolean).join(' | ');
    await batch.save();
    await ClinicLedgerEntry.updateMany(
      { _id: { $in: batch.ledgerEntryIds || [] } },
      { $set: { status: 'disputed' } },
    );
    return res.json({ batch });
  } catch (err) {
    next(err);
  }
}

export async function listClinicStaff(req, res, next) {
  try {
    const users = await User.find({ role: 'clinic_staff' })
      .select('name phone role clinicId')
      .populate('clinicId', 'name')
      .sort({ name: 1 })
      .lean();
    return res.json({ users });
  } catch (err) {
    next(err);
  }
}
