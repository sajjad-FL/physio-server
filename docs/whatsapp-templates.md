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
| **Current `wid`** | `26913` (env `AUTHKEY_WID`, template `physiokhom_auth`) |
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

### 2. `physio_assigned` / `physiokhom_appointment_confirmation`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en_US |
| **When** | Appointment confirmed (physio accept / online paid) **and** patient notified on manager or clinic assign |
| **AuthKey Message ID (`wid`)** | `26916` (`FAST2SMS_MESSAGE_ID_APPOINTMENT`) |
| **Meta Template ID** | `1354025180221960` |

**Body (update in Fast2SMS / Meta — keep same 5 variables)**

```text
Hello {{1}},

Thank you for booking with {{2}}.

Your {{3}} on {{4}} at {{5}} is confirmed.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Physio / care manager / clinic name | `Dr. Ankit Sharma` / `Priya Das` / `Kokrajhar Clinic` |
| `{{3}}` | Visit type | `home visit` / `clinic visit` / `online consultation` |
| `{{4}}` | Date | `22 Jul 2026` |
| `{{5}}` | Time | `10:00 AM` |

**Notes:** Same message ID `26916` — edit the approved template body in Fast2SMS/Meta (or submit a new version if Meta requires it). App code already sends `{{1}}…{{5}}` in this order; no server change needed after you update the template text.

**Was:**
```text
Hello {{1}},
Thank you for booking with {{2}}.
Your appointment for {{3}} on {{4}} at {{5}} is confirmed.
```
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
| `{{3}}` | Time slot | `4:00 PM` |

---

### 4b. `physio_upcomming_appointment` (physio daily cron)

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en_US |
| **When** | Every day at **3:00 AM IST** — one WhatsApp per visit the physio has that day |
| **AuthKey Message ID (`wid`)** | `26927` (`AUTHKEY_WID_PHYSIO_UPCOMING`) |
| **Meta Template ID** | `1329983772350481` |
| **Status** | Approve in AuthKey before production sends succeed |

**Body**

```text
You have an upcoming event
Reminder: You RSVP'ed to {{1}} by {{2}}.
The event starts on {{3}} at {{4}} at {{5}} location.
```

**Variables (as sent by cron)**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Visit index + type | `Visit 1 of 3: home visit` |
| `{{2}}` | Patient name | `Riya` |
| `{{3}}` | Date | `28 Jul 2026` |
| `{{4}}` | Time slot | `10:00-11:00` |
| `{{5}}` | Location | patient address / Clinic / Online |

---

### 5. `payment_received` / `payment_confirmation_1`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en_US |
| **When** | Payment or installment is verified / recorded |
| **AuthKey Message ID (`wid`)** | `26922` (`AUTHKEY_WID_PAYMENT_RECEIVED`) |
| **Meta Template ID** | `1506617894105853` |

**Body**

```text
Hi {{1}},

We have received your payment of {{2}} for {{3}}.

Thank you for your payment.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Amount (include currency in the value) | `Rs.1,500` |
| `{{3}}` | What the payment is for | `home visit` / `Session 1` |
---

### 6. Manager / clinic assignment — **reuse live templates** (wired)

Do **not** create separate Meta templates for these. Sends use:

| Audience | Template | Message ID |
|----------|----------|------------|
| Patient (manager or clinic assigned) | Appointment confirmation | `26916` |
| Care manager (new case) | Physio upcoming style | `26927` |
| Clinic staff / clinic phone | Physio upcoming style | `26927` |

**Patient vars (`26916`):** `{{1}}` name · `{{2}}` manager or clinic name · `{{3}}` visit type · `{{4}}` date · `{{5}}` time  

**Staff vars (`26927`):** `{{1}}` `New case: home visit` / `New booking: clinic visit` · `{{2}}` patient · `{{3}}` date · `{{4}}` time · `{{5}}` location  

**Triggers (code):** `notifyOnManagerAssigned` / `notifyOnClinicAssigned` in `utils/assignmentWhatsApp.js` — admin assign/reassign manager, zone auto-assign on home booking, admin/manager assign clinic.

---

### 6-legacy (optional dedicated copy — only if Meta wording must change)

<details>
<summary>Optional dedicated templates (not required while reusing 26916 / 26927)</summary>

### `clinic_assigned` (patient)

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Admin or care manager assigns the booking to a clinic |

**Body**

```text
Hi {{1}}, your PhysiOkhom {{2}} has been assigned to {{3}}. The clinic team will guide you for your visit on {{4}} at {{5}}.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Visit type | `home visit` / `clinic visit` |
| `{{3}}` | Clinic name | `Kokrajhar Clinic` |
| `{{4}}` | Date | `22 Jul 2026` |
| `{{5}}` | Time slot | `10:00 AM` |

### `care_manager_assigned` (patient)

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | Admin assigns a care manager to the patient's booking (or auto-assign by zone) |

**Body**

```text
Hi {{1}}, PhysiOkhom has assigned care manager {{2}} to your {{3}} on {{4}} at {{5}}. They will contact you for the next steps.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Patient name | `Riya` |
| `{{2}}` | Care manager name | `Priya Das` |
| `{{3}}` | Visit type | `home visit` |
| `{{4}}` | Date | `22 Jul 2026` |
| `{{5}}` | Time slot | `10:00 AM` |

### `care_manager_new_case` (care manager)

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | A booking is assigned to this care manager — notify the manager |

**Body**

```text
Hi {{1}}, you have a new PhysiOkhom case. Patient {{2}} · {{3}} on {{4}} at {{5}}. Open the app to review the booking.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Care manager name | `Priya Das` |
| `{{2}}` | Patient name | `Riya` |
| `{{3}}` | Visit type | `home visit` |
| `{{4}}` | Date | `22 Jul 2026` |
| `{{5}}` | Time slot | `10:00 AM` |

### `clinic_new_booking` (clinic staff)

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en |
| **When** | A booking is assigned to this clinic — notify clinic staff phone(s) |

**Body**

```text
Hi {{1}}, {{2}} has a new PhysiOkhom booking. Patient {{3}} · {{4}} on {{5}} at {{6}}. Open the clinic dashboard to review.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Clinic staff / clinic contact name | `Front desk` / `Amit` |
| `{{2}}` | Clinic name | `Kokrajhar Clinic` |
| `{{3}}` | Patient name | `Riya` |
| `{{4}}` | Visit type | `clinic visit` |
| `{{5}}` | Date | `22 Jul 2026` |
| `{{6}}` | Time slot | `10:00 AM` |

</details>

---

### 7. `session_completed` / `feedback_survey_form_1`

| Field | Value |
|--------|--------|
| **Category** | UTILITY |
| **Language** | en_US |
| **When** | After every treatment session is marked completed |
| **AuthKey Message ID (`wid`)** | `26926` (`AUTHKEY_WID_FEEDBACK_SURVEY`) |
| **Meta Template ID** | `1006075285582544` |

**Body**

```text
Rate your experience

Your feedback is important to us. Please take a quick survey about your recent {{1}} experience.
```

**Variables**

| Var | Meaning | Example |
|-----|---------|---------|
| `{{1}}` | Experience / visit type | `home visit` / `Session 2 physiotherapy` |

**Notes:** Includes a **Take survey** button. Dynamic URL suffix (if configured) receives the booking id so the patient can rate in-app.

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
| `physio_otp_verify` / `physiokhom_auth` | AUTHENTICATION | 1 | `26913` | `AUTHKEY_WID` | Live |
| `booking_received` | UTILITY | 4 | | `AUTHKEY_WID_BOOKING_RECEIVED` | Pending |
| `physio_assigned` / `physiokhom_appointment_confirmation` | UTILITY | 5 | `26916` | `AUTHKEY_WID_APPOINTMENT_CONFIRMED` | Live |
| `care_plan_ready` | UTILITY | 2 | | `AUTHKEY_WID_CARE_PLAN_READY` | Pending |
| `visit_rescheduled` | UTILITY | 3 | | `AUTHKEY_WID_VISIT_RESCHEDULED` | Pending |
| `physio_upcomming_appointment` | UTILITY | 5 | `26927` | `AUTHKEY_WID_PHYSIO_UPCOMING` | Pending Meta — cron wired |
| `payment_received` / `payment_confirmation_1` | UTILITY | 3 | `26922` | `AUTHKEY_WID_PAYMENT_RECEIVED` | Live |
| `clinic_assigned` / manager assign patient | UTILITY | 5 | `26916` | `FAST2SMS_MESSAGE_ID_APPOINTMENT` | **Reuse live** appointment |
| `care_manager_new_case` / `clinic_new_booking` | UTILITY | 5 | `26927` | `FAST2SMS_MESSAGE_ID_PHYSIO_UPCOMING` | **Reuse live** upcoming |
| `session_completed` / `feedback_survey_form_1` | UTILITY | 1 | `26926` | `AUTHKEY_WID_FEEDBACK_SURVEY` | Live |
| `account_created_by_staff` | UTILITY | 2 | | `AUTHKEY_WID_ACCOUNT_CREATED` | Pending |

---

## After you have the `wid`s

Share the filled tracking table (or paste the IDs). Next engineering step:

1. Add the env keys above to `server/.env` / `.env.example`.
2. Extend AuthKey send helper to accept `wid` + ordered vars `1..n`.
3. Replace mock `sendWhatsApp` calls for these events with the matching template.
