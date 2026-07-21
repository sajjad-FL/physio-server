# PhysiOkhom WhatsApp templates (AuthKey / Meta approval)

Use this copy when creating templates in AuthKey (or Meta Business Manager). After approval, note each template **`wid`** (AuthKey template ID). Wiring env keys and sends is a later step.

**Language:** English (`en` or `en_IN`)  
**Brand:** PhysiOkhom  
**Placeholder style:** AuthKey numbered vars `{{1}}`, `{{2}}`, … (same as live OTP template)

---

## How to submit (AuthKey)

1. Create a new WhatsApp template with the **name**, **category**, and **body** below.
2. Map variables in order (`1`, `2`, `3` …).
3. Submit for Meta approval.
4. When approved, record the **`wid`** in the tracking table at the bottom of this file.

**Approval tips**

- Use **AUTHENTICATION** only for OTP.
- Use **UTILITY** for booking / payment / care updates (transactional, not promo).
- Keep bodies short; no marketing offers, coupons, or upsell language.
- Avoid raw URLs in the body if possible (add a URL button later if needed).

---

## Already live (reference only — do not recreate unless replacing)

### `physio_otp_verify`

| Field | Value |
|--------|--------|
| **Category** | AUTHENTICATION |
| **Language** | en |
| **Current `wid`** | `41531` (env `AUTHKEY_WID`) |
| **When** | Signup verification, forgot password |

**Body**

```text
{{1}} is your PhysiOkhom verification code. Do not share this code with anyone.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | 4-digit OTP | `4821` |

**Notes:** Already configured. Keep as-is unless AuthKey requires a new AUTHENTICATION template.

---

## New templates (create and submit)

### 1. `booking_received`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Patient booking request is created (home, clinic, online, or technique) |

**Body**

```text
Hi {{1}}, PhysiOkhom has received your {{4}} booking for {{2}} at {{3}}. We will update you when the next step is confirmed.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient first / full name | `Riya` |
| `{{2}}` | Visit date | `22 Jul 2026` |
| `{{3}}` | Time slot | `10:00 AM` |
| `{{4}}` | Visit type phrase | `home visit`, `clinic visit`, `online consult`, `technique home visit`, `technique clinic visit` |

**Notes:** Covers standard home/online/clinic and technique bookings (technique may be home or clinic). Pass a short plain phrase in `{{4}}` — no marketing language.

**Technique note:** Technique treatments can be booked as a **home visit** or a **clinic visit**. Use the same `booking_received` / `physio_assigned` / payment templates; set `{{4}}` (or visit-type wording in other templates) accordingly.

---

### 2. `physio_assigned`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | A physiotherapist is assigned to the booking |

**Body**

```text
Hi {{1}}, {{2}} has been assigned as your physiotherapist for {{3}} at {{4}}. Open PhysiOkhom for visit details.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Physiotherapist name | `Dr. Ankit Sharma` |
| `{{3}}` | Visit date | `22 Jul 2026` |
| `{{4}}` | Time slot | `10:00 AM` |

**Notes:** Plain confirmation only; no fees or promo text.

---

### 3. `care_plan_ready`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Care plan is ready / made live for the patient |

**Body**

```text
Hi {{1}}, your PhysiOkhom care plan is ready ({{2}}). Please open the app to review and confirm the plan.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Short plan summary | `6 sessions` or `Home care plan` |

**Notes:** UTILITY — patient must act (review/consent). Keep `{{2}}` factual (session count or plan type).

---

### 4. `visit_rescheduled`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | A visit / session is rescheduled |

**Body**

```text
Hi {{1}}, your PhysiOkhom visit has been rescheduled to {{2}} at {{3}}. Open the app for full details.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | New date | `24 Jul 2026` |
| `{{3}}` | New time | `4:00 PM` |

---

### 5. `payment_received`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Payment or installment is verified / recorded |

**Body**

```text
Hi {{1}}, PhysiOkhom has received your payment of Rs.{{2}}. Thank you.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Amount (number, no currency symbol if Meta rejects “Rs.” in body — then use plain digits only) | `1500` |

**Notes:** If Meta rejects “Rs.”, use: `…payment of {{2}}. Thank you.` and pass `1500` or `INR 1500` in `{{2}}`.

**Alternate body (if currency symbol causes rejection)**

```text
Hi {{1}}, PhysiOkhom has received your payment of {{2}}. Thank you.
```

---

### 6. `clinic_assigned`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Patient case is assigned to a clinic facility |

**Body**

```text
Hi {{1}}, your PhysiOkhom care will continue at {{2}}. The clinic team will guide you for your visit.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Clinic name | `Kokrajhar Clinic` |

---

### 7. `session_completed`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | A treatment session is marked completed |

**Body**

```text
Hi {{1}}, your PhysiOkhom session ({{2}}) is marked complete. Open the app to see remaining sessions and next steps.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Session label | `Session 2 of 6` |

---

### 8. `account_created_by_staff`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Admin, care manager, or clinic staff creates a walk-in patient account |

**Body**

```text
Hi {{1}}, a PhysiOkhom account was created for you. Log in with mobile {{2}} and the temporary password shared by our staff. You can reset it anytime using Forgot password.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Mobile number (10 digits or `+91…`) | `9876543210` |

**Notes:** Do **not** put the password in the WhatsApp template (security + Meta policy). Staff shares the temporary password in person / separately.

---

## Tracking table (fill after approval)

| Template name | Category | Vars | AuthKey `wid` | Env key (later) | Status |
|---------------|----------|------|---------------|-----------------|--------|
| `physio_otp_verify` | AUTHENTICATION | 1 | `41531` | `AUTHKEY_WID` | Live |
| `booking_received` | UTILITY | 4 | | `AUTHKEY_WID_BOOKING_RECEIVED` | Pending |
| `physio_assigned` | UTILITY | 4 | | `AUTHKEY_WID_PHYSIO_ASSIGNED` | Pending |
| `care_plan_ready` | UTILITY | 2 | | `AUTHKEY_WID_CARE_PLAN_READY` | Pending |
| `visit_rescheduled` | UTILITY | 3 | | `AUTHKEY_WID_VISIT_RESCHEDULED` | Pending |
| `payment_received` | UTILITY | 2 | | `AUTHKEY_WID_PAYMENT_RECEIVED` | Pending |
| `clinic_assigned` | UTILITY | 2 | | `AUTHKEY_WID_CLINIC_ASSIGNED` | Pending |
| `session_completed` | UTILITY | 2 | | `AUTHKEY_WID_SESSION_COMPLETED` | Pending |
| `account_created_by_staff` | UTILITY | 2 | | `AUTHKEY_WID_ACCOUNT_CREATED` | Pending |

---

## After you have the `wid`s

Share the filled tracking table (or paste the IDs). Next engineering step:

1. Add the env keys above to `server/.env` / `.env.example`.
2. Extend AuthKey send helper to accept `wid` + ordered vars `1..n`.
3. Replace mock `sendWhatsApp` calls for these events with the matching template.
