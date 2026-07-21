import { createPatientUser, CreatePatientError } from '../services/createPatientUser.js';

export async function createStaffPatient(req, res, next) {
  try {
    const user = await createPatientUser({
      phone: req.body?.phone,
      name: req.body?.name,
      password: req.body?.password,
    });
    return res.status(201).json({ user });
  } catch (err) {
    if (err instanceof CreatePatientError) {
      return res.status(err.status).json({ message: err.message });
    }
    next(err);
  }
}
