const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmailOptional(email) {
  const s = String(email ?? '').trim();
  if (!s) return { ok: true };
  if (s.length > 254) return { ok: false, message: 'Email is too long' };
  if (!EMAIL_RE.test(s)) return { ok: false, message: 'Enter a valid email address' };
  return { ok: true };
}

/**
 * @param {Record<string, unknown>} basic
 * @returns {{ errors: Record<string, string> }}
 */
export function validateBasicSection(basic) {
  const errors = {};
  const name = String(basic?.name ?? '').trim();
  if (!name) errors.name = 'Full name is required';
  else if (name.length < 2) errors.name = 'Name must be at least 2 characters';
  else if (name.length > 120) errors.name = 'Name is too long';

  const emailTrim = String(basic?.email ?? '').trim();
  if (!emailTrim) errors.email = 'Email is required';
  else {
    const emailCheck = validateEmailOptional(emailTrim);
    if (!emailCheck.ok) errors.email = emailCheck.message;
  }

  const loc = String(basic?.location ?? '').trim();
  if (!loc) errors.location = 'Coverage / location is required';
  else if (loc.length < 2) errors.location = 'Location must be at least 2 characters';
  else if (loc.length > 300) errors.location = 'Location is too long';

  if (basic?.dob != null && String(basic.dob).trim()) {
    const d = new Date(basic.dob);
    if (Number.isNaN(d.getTime())) errors.dob = 'Invalid date of birth';
    else {
      const now = new Date();
      if (d > now) errors.dob = 'Date of birth cannot be in the future';
      const age = (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
      if (age < 18) errors.dob = 'You must be at least 18 years old';
      if (age > 100) errors.dob = 'Please check the date of birth';
    }
  }

  const gender = String(basic?.gender ?? '').trim();
  if (gender && !['female', 'male', 'other', 'prefer_not_say'].includes(gender)) {
    errors.gender = 'Select a valid option';
  }

  const address = String(basic?.address ?? '').trim();
  if (address.length > 500) errors.address = 'Address is too long (max 500 characters)';

  return { errors };
}

/**
 * @param {Record<string, unknown>} qualification
 */
export function validateQualificationSection(qualification) {
  const errors = {};
  const degree = String(qualification?.degree ?? '').trim();
  if (!degree) errors.degree = 'Degree is required';
  else if (degree.length > 200) errors.degree = 'Degree is too long';

  const university = String(qualification?.university ?? '').trim();
  if (!university) errors.university = 'University is required';
  else if (university.length > 200) errors.university = 'University name is too long';

  if (qualification?.year != null && qualification.year !== '') {
    const y = Number(qualification.year);
    const current = new Date().getFullYear();
    if (!Number.isFinite(y)) errors.year = 'Enter a valid graduation year';
    else if (y < 1950 || y > current + 1) errors.year = `Year must be between 1950 and ${current + 1}`;
  } else {
    errors.year = 'Graduation year is required';
  }

  const reg = String(qualification?.registrationNumber ?? '').trim();
  if (!reg) errors.registrationNumber = 'Registration number is required';
  else if (reg.length < 3) errors.registrationNumber = 'Registration number is too short';
  else if (reg.length > 80) errors.registrationNumber = 'Registration number is too long';

  return { errors };
}

/**
 * @param {Record<string, unknown>} practice
 */
export function validatePracticeSection(practice) {
  const errors = {};
  if (practice?.experience == null || practice.experience === '') {
    errors.experience = 'Experience (years) is required';
  } else {
    const e = Number(practice.experience);
    if (!Number.isFinite(e) || e < 0) errors.experience = 'Enter a valid number of years';
    else if (e > 80) errors.experience = 'Enter a realistic experience value';
  }

  const spec = String(practice?.specialization ?? '').trim();
  if (!spec) errors.specialization = 'Specialization is required';
  else if (spec.length < 2) errors.specialization = 'Specialization must be at least 2 characters';
  else if (spec.length > 120) errors.specialization = 'Specialization is too long';

  const st = practice?.serviceType;
  if (st != null && st !== '' && !['online', 'home', 'both'].includes(st)) {
    errors.serviceType = 'Invalid service type';
  }

  const areas = practice?.areas;
  const areaList =
    typeof areas === 'string'
      ? areas.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
      : Array.isArray(areas)
        ? areas.map((s) => String(s).trim()).filter(Boolean)
        : [];
  if (areaList.length === 0) errors.areas = 'Add at least one service area';

  if (practice?.fees == null || practice.fees === '') {
    errors.fees = 'Fee per session is required';
  } else {
    const fee = Number(practice.fees);
    if (!Number.isFinite(fee) || fee <= 0) errors.fees = 'Enter a valid fee greater than zero (₹)';
    else if (fee > 500000) errors.fees = 'Fee seems unreasonably high — please check';
  }

  return { errors };
}

function hasUrl(s) {
  return Boolean(s && String(s).trim());
}

/**
 * Full physio document (lean) before submit.
 * @param {Record<string, unknown>} p
 * @param {{ requireSignedNda?: boolean }} [opts]
 */
export function validateSubmitReady(p, opts = {}) {
  const errors = {};

  const basic = {
    name: p.name,
    email: p.email,
    location: p.location,
    dob: p.dob,
    gender: p.gender,
    address: p.address,
  };
  Object.assign(errors, validateBasicSection(basic).errors);

  const q = p.qualification || {};
  Object.assign(
    errors,
    validateQualificationSection({
      degree: q.degree,
      university: q.university,
      year: q.year,
      registrationNumber: q.registrationNumber,
    }).errors
  );

  Object.assign(
    errors,
    validatePracticeSection({
      experience: p.experience,
      specialization: p.specialization,
      serviceType: p.serviceType,
      areas: (p.serviceAreas || []).join(', '),
      fees: p.pricePerSession,
    }).errors
  );

  const cert = hasUrl(q.certificateUrl);
  const du = p.documentUrls || {};
  if (!cert) errors.certificate = 'Upload your qualification certificate';
  if (!hasUrl(du.idProof)) errors.idProof = 'Upload ID proof';
  if (!hasUrl(du.registrationCertificate)) errors.registrationCertificate = 'Upload registration certificate';
  if (!hasUrl(du.selfieWithId)) errors.selfieWithId = 'Upload a selfie with your ID';

  if (opts.requireSignedNda && !hasUrl(du.signedNda)) {
    errors.signedNda = 'Download the NDA, sign it, and upload the signed copy';
  }

  return { errors, ok: Object.keys(errors).length === 0 };
}
