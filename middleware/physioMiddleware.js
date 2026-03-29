import Physiotherapist from '../models/Physiotherapist.js';

/** After authenticateJwt + requireRoles('physio'), load `req.physio`. */
export async function attachPhysio(req, res, next) {
  const pid = req.auth?.physioId;
  if (!pid) {
    return res.status(403).json({ message: 'Physiotherapist session required' });
  }

  const physio = await Physiotherapist.findById(pid).lean();
  if (!physio) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  req.physio = { id: physio._id.toString(), phone: physio.phone, doc: physio };
  return next();
}
