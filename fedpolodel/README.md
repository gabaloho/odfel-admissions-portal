# ODFel Admissions Portal

ODFel is a reusable open and distance flexible learning admissions portal. Schools can clone it, configure their own identity and programmes, and publish their approved admission information.

It is a React/Vite portal backed by Node.js/Express.

- React frontend in `fedpolodfel-react/`
- Backend entry in `app.js`
- Firestore persistence for Cloud Run; SQLite in `data/app.db` for local development and tests
- Admin and payment workflows available in backend mode

## Current features

- Applicant registration and login (passwords of at least 8 characters)
- Public "Check Status", "Continue Application" and "Print Documents" pages sign applicants in with their email and password and take them to their dashboard, unpaid invoice, or receipt
- Session-based authentication
- Pre-application flow
- Invoice generation and invoice view (flat NGN 25,000 application fee by default)
- Paystack hosted checkout in configured environments; dummy-card checkout is development-only
- Invoice and receipt PDF download, and receipt sharing
- Applicant dashboard
- Check status and print document pages
- Admin login and role-based access
- Admin user management (`/admin/users`)
- Super-admin institution setup (`/admin/institution`) with programme presets and custom programmes
- Initial SIS: schools, departments, programme assignments, admission decisions and matriculated student records (`/admin/sis`)
- Academic terms, programme courses and student self-registration (`/admin/courses` and `/courses`)
- Programme grading scales, audited result drafts and publications (`/admin/results` and `/results`)
- Individually assigned student fees with full-invoice checkout (`/admin/student-fees` and `/fees`)
- Course-meeting attendance and basic operational counts (`/admin/attendance`, `/attendance` and `/admin/reports`)
- Admin payment verification console (`/admin/payments`)
- Manual payment verification/override by admins, with an audit trail of who did what
- Reconciliation report and CSV export
- Signed payment webhook verification (`/webhooks/payments`)

## Admin roles

- `super_admin`: full access (users + payments)
- `finance_admin`: payment operations access
- `auditor`: payment view access

Academic SIS administration is restricted to `super_admin`. Finance admins can assign and review student fee invoices and see the student identifiers needed for that workflow; auditors cannot assign fees.

Local admin account: on a fresh local seed the backend creates an `admin` user.
Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in your environment before the first
start, and always do so in production. The password must satisfy the admin
password policy (at least 10 characters with upper case, lower case, a number
and a special character).

## First-run institution setup

Start the backend and frontend, then open the portal. The first-run screen directs you to sign in as a super administrator. Enter the institution's identity and contact details, application fee, currency and study modes; select programmes from the presets or add your own; then save. Settings are persisted in the configured backend database and can be changed later under **Institution Settings**. The first-run redirect is a frontend workflow, not an API access-control boundary.

Existing programmes are offered for selection; removing one from admissions does not delete it or its historical applications. Existing invoices keep their original fee and currency. Configure an existing installation without deleting its data. English is the only supported operating language in this phase; Hausa, Yoruba, Igbo, French, Spanish, Portuguese, German and Swahili are not yet translated. This setup does not implement a complete student information system or institution-specific admission criteria.

## Initial SIS workflow

After institution setup, a super admin opens **Student Information** and creates schools and departments, then assigns each programme to a department. Review each applicant's submitted information and payment status before recording an admission or rejection decision with a reason. Payment does not automatically grant admission, and this phase does not enforce institution-specific eligibility or payment requirements. A decision can be corrected until matriculation; applicants cannot edit a decided application.

Matriculation is a separate action for an admitted applicant. Staff enter a unique institution-issued matriculation number; the programme must be assigned to a department. The student record retains the programme, department and school at matriculation even if the programme is reassigned later. Matriculation and its number cannot currently be reversed or edited through the interface. Decisions and matriculation are audited; the applicant sees the application status and their own matriculation number on the dashboard.

### Course registration

A super admin creates an academic session/term, programme-specific courses and term offerings under **Courses**. Terms start closed; staff open or close registration manually. A matriculated student can add or drop their own programme's offered courses while the term is open, and can see their registered or dropped courses after it closes. Each change is audited. Registration does not currently depend on tuition payment.

Course and term names, units and offerings cannot yet be corrected or deleted through the interface. Programme level, curriculum versions, prerequisites, credit-load limits, timetable clashes, automatic registration dates and approval workflows are not enforced. Staff must manage these manually; do not rely on this phase for production registration.

### Results and grading

A super admin configures an institution-approved grading scale for each programme under **Results**; no scale is preapproved or supplied by the system. Bands specify a grade label, minimum score (0 to 100), and grade points. The lowest band must begin at zero; a band applies up to, but not including, the next minimum. Staff close registration for the term before entering a score. A super admin saves a draft with a reason, reviews the score and calculated grade, and explicitly publishes it. Students can only view their own published results.

A correction is a new draft and publication with a reason. The previously published result remains visible until the correction is published, and publication history and the scale used are retained. The system prevents a course with any recorded result from being dropped, even if the registration window is reopened. Publication requires the same draft and grading scale that the admin reviewed. Result entry and publishing currently both require a super admin; separate staff roles or independent approval are not yet implemented.

Students can download an **unofficial** PDF academic record containing only their own published results. It is marked unofficial on every page and does not calculate GPA, determine graduation status, or provide certification.

### Student fees

A super admin or finance admin can assign a named fee, amount and currency to an individual matriculated student under **Student Fees**. Review existing invoices before assigning: each new assignment creates a separate charge, even if its details match another. If confirmation is interrupted, the same browser tab retains the request for a safe retry; check the invoice list before forgetting it. Students can view only their own fees and pay the full invoice through the existing hosted checkout. Admission invoices remain separate, and student fees do not gate course registration.

The existing finance-office manual verification and audit workflow also applies to student invoices. Installments, automatic fee schedules, due dates, term associations, waivers, refunds and corrections are not implemented. Choose a currency supported by the configured payment provider.

### Attendance and operational reports

A super admin creates a course meeting with a date and label, then records each currently registered student's status as present, absent, late or excused. Different labels allow multiple meetings on the same day. Unmarked meetings are not counted as absences. Changes are audited, and a stale edit is rejected until the roster is reloaded. If a student drops a course, previously recorded attendance remains visible but cannot be edited until they register again. Students can view their own recorded statuses. Meetings cannot currently be edited or deleted; verify details before creating them.

The super-admin **Reports** page shows current institution-wide counts for admissions, students, registrations, published results, meetings, recorded attendance and student-fee invoice statuses. Counts are operational summaries, not certified academic or financial reports; they do not calculate attendance percentages, revenue, GPA or graduation eligibility. Data can change while the report loads.

This is a foundation, not a complete or production-ready SIS. GPA/CGPA policies, repeats, official transcripts, attendance policies, detailed staff roles, correction workflows and advanced reporting remain to be implemented. School and department editing and deletion are also not yet available. Admissions, student, fee, course, attendance and result lists currently load all records, so pagination and scale testing are required before institutional use. Firestore tests use doubles; emulator and staging validation are still required.

The initial administrator and infrastructure configuration still require environment variables or a secret manager. Never enter payment keys or other secrets in institution settings. Set the public fee and currency to values supported by your payment provider, and test the complete workflow before accepting applications.

## Environment variables

The optional frontend variables below provide legacy defaults before setup. Saved institution settings override them; they are not needed to configure a new institution:

- `VITE_INSTITUTION_NAME`
- `VITE_INSTITUTION_WEBSITE` (optional; must use HTTP or HTTPS)
- `VITE_INSTITUTION_EMAIL` (optional)
- `VITE_INSTITUTION_PHONE` (optional)
- `VITE_INSTITUTION_ADDRESS` (optional)
- `VITE_INSTITUTION_LOGO` (optional root-relative path or HTTP/HTTPS URL)
- `VITE_MODES_OF_STUDY` (comma-separated; defaults to full-time, part-time, and distance learning)

For local development, optionally copy `backend.env.example` to `backend.env` (next to `app.js`) and edit it. The backend loads it on start, and variables set in the real environment override it. Set `BACKEND_ENV_FILE` to load a different file. `PROGRAMS_JSON` optionally seeds an initial non-empty JSON array of objects with unique `id` and `name` values, for example:

```json
[{"id":"undergraduate","name":"Undergraduate Programme"},{"id":"postgraduate","name":"Postgraduate Programme"}]
```

Programs and the initial admin are seeded on the first Firestore start, or when the SQLite programs table is empty. Changing the environment later does not update seeded records; manage available programmes through institution setup instead.

The initial application fee defaults to **NGN 25,000**. `APPLICATION_FEE_AMOUNT`, `APPLICATION_FEE_CURRENCY` (three-letter code), and `APPLICATION_FEE_DESCRIPTION` supply initial defaults; saved institution settings take precedence for new invoices. A zero fee disables card checkout, but an automatic free-application completion workflow is not implemented. The fee is fixed on an invoice when it is created, so changing it does not reprice existing invoices.

The saved institution name appears on newly generated invoice and receipt PDFs. Before setup, `INSTITUTION_NAME` or the frontend `.env` supplies the default.

## Payments

Who can mark an invoice as **Paid**:

- **A verified Paystack webhook** (`POST /webhooks/payments`) or server-side Paystack transaction verification after the return redirect. Webhook signatures must be valid (otherwise `401`), and the paid amount and currency must match the invoice (otherwise the event is recorded but not applied).
- **An admin with `payments:write`** (`super_admin` or `finance_admin`), using the manual verification form on `/admin/payments`. A note is required.

Applicants cannot mark their own invoice as paid. `POST /api/invoice/:invoiceNumber/pay` and `POST /invoice/:invoiceNumber/pay` return `403`. A browser session is either an applicant session or an admin session, never both: logging in as one logs out the other. Admin access is re-checked against the database on every request, so deactivating an admin or changing their role takes effect immediately.

Auto Reconcile on the admin page only repairs invoices with a gateway-verified successful payment for the **exact** invoice amount and currency. An underpaid event is never turned into "Paid". Admins can open any invoice or receipt PDF from the invoice list. The reconciliation CSV neutralises spreadsheet formulas in applicant-entered data.

Every status change is written to the audit trail with who performed it. Examples: `Payment gateway webhook (paystack, signature verified)`, `Admin: jane (finance_admin)`, and `Applicant: a@b.com` for starting a checkout.

### Paystack hosted checkout

When `PAYSTACK_SECRET_KEY` is configured, applicants are redirected to Paystack's hosted checkout. The server initializes the transaction from the stored invoice amount in minor units, then verifies the returned reference with Paystack; a browser redirect alone never marks an invoice paid. Signed webhook notifications are also supported and checked against the exact raw request body. The amount, currency, invoice metadata, and reference are checked before the invoice is updated.

Configure `PAYSTACK_SECRET_KEY`, `PAYSTACK_WEBHOOK_SECRET` (`whsec_...`), and `PUBLIC_BASE_URL` for deployment. Use Cloud Run Secret Manager for both secrets. `PAYSTACK_PREVIOUS_WEBHOOK_SECRETS` can temporarily contain comma-separated previous webhook-signing secrets during rotation. The callback must be reachable over HTTPS and match the origin configured in Paystack.

Current timestamped `Paystack-Signature` headers are validated with a five-minute timestamp window and constant-time HMAC-SHA512 comparison. Legacy `x-paystack-signature` headers are also accepted while Paystack signing-secret migration is in progress. Do not remove the Paystack API secret until events use the timestamped signing header.

### Card checkout (local test mode)

A logged-in applicant can use card checkout on their invoice in test mode. This is a local mock gateway, not a live integration. It only accepts these dummy cards, with any future expiry and any CVC:

| Card number | Result |
| --- | --- |
| `4242 4242 4242 4242` | Approved (Visa) |
| `5555 5555 5555 4444` | Approved (Mastercard) |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Declined (insufficient funds) |

The applicant's request only carries card details. The server charges the stored invoice amount, and the mock gateway reports the result as a signed webhook through the same verification code as `/webhooks/payments`. Only the last four digits of the card are stored. Once paid, the invoice page shows a PAID stamp, no pay button, and **Download Receipt (PDF)** / **Share Receipt** buttons.

**Share Receipt** opens the device's own share menu (WhatsApp, Telegram, email, ...) with the receipt PDF attached, where the browser supports it. That covers most phones and Chrome/Edge/Safari on Windows and macOS. Browsers only allow this on `https://` or `localhost`. Elsewhere (for example Firefox, Chrome on Linux, or a phone opening the dev server at `http://<computer-ip>:5173`), an in-app share window offers WhatsApp, Email, Text message, Copy details and Download PDF. These options share the receipt details as text; attach the downloaded PDF to send the file itself.

The mock gateway is on by default in development and off when `NODE_ENV=production`; production refuses to start if it is enabled. Set `MOCK_PAYMENTS_ENABLED=true|false` only for local testing. Flutterwave `verif-hash` validation remains available when a dedicated `PAYMENT_WEBHOOK_SECRET` is configured.

The tests cover raw-body HMAC validation. Use Paystack's dashboard to send a test event to a publicly reachable staging webhook; do not use a production secret for local testing.

Also set these for production:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET` (random, at least 32 characters)
- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_WEBHOOK_SECRET`
- `PUBLIC_BASE_URL` (HTTPS origin, no path)
- Secure session cookies are enforced in production; Cloud Run's HTTPS proxy is trusted.

Webhook signature handling:

- Paystack: validates timestamped `Paystack-Signature` using the raw body and HMAC-SHA512; legacy `x-paystack-signature` is supported during migration
- Flutterwave: validates `verif-hash` / `x-flutterwave-signature`

## Local development

Requires **Node.js 22.13 or newer**. The included `.nvmrc` selects Node.js 22,
and `.npmrc` makes `npm install` reject older versions.

1. Install root dependencies:

```bash
npm install
```

2. Install frontend dependencies:

```bash
npm --prefix fedpolodfel-react install
```

3. Start the backend and the frontend together:

```bash
npm run dev
```

4. Open:

- <http://localhost:5173>

`npm run dev` starts the Express backend on port 3000, waits until it is ready, and then starts the Vite dev server on port 5173. Ctrl+C stops both. If a backend is already running on port 3000 (for example from `npm run backend:start`), it is reused. If another program is using port 3000, run `PORT=3001 npm run dev` instead. Extra arguments go to Vite, for example `npm run dev -- --host`.

The Vite dev server (and `npm run preview`) proxies `/api`, `/webhooks`, and `/admin/payments/export.csv` to the backend. The browser only talks to port 5173. If the backend is unavailable, the portal displays an error instead of loading default settings. To run the frontend against a backend somewhere else, use `npm run ui:dev` with `BACKEND_URL` set in `fedpolodfel-react/.env` or in the shell. `API_PROXY_TARGET` is also accepted as a compatibility alias.

The local SQLite database is created at `data/app.db` on first start. Set `DATABASE_PATH` to use a different file.

## Tests

```bash
npm test
```

The tests start the backend on isolated local SQLite databases and exercise the Firestore adapter and sessions using injected in-memory doubles. They cover payment authorization, webhook signatures, card checkout, receipts/PDFs, and the audit trail. The doubles do not verify real Firestore SDK behavior, IAM, indexes, or Cloud Run connectivity; validate those separately with the emulator and a staging project before launch.

## Build and preview

Build frontend bundle:

```bash
npm run build
```

Preview production bundle locally:

```bash
npm run preview
```

## Single-server mode

After `npm run build`, `npm run backend:start` serves both the built React app and the API from <http://127.0.0.1:3000>. No proxy is needed.

## Firestore and Cloud Run setup

This phase targets a **new empty Firestore database in Native mode**; it does not migrate SQLite data. Choose a Firestore location available to your project, considering Nigeria's data-residency and latency requirements: locations cannot be changed after database creation. Confirm the available locations with Google Cloud before creating it.

- Set `DATA_STORE=firestore`, `GOOGLE_CLOUD_PROJECT` to the project ID, and `NODE_ENV=production`. Production refuses SQLite, an unset provider/project, and an emulator host.
- Attach a dedicated Cloud Run service account with the minimum Firestore permissions (for example `roles/datastore.user` for this database) and use Application Default Credentials. Do not put service-account keys in the repository or environment files.
- Supply `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `PAYSTACK_SECRET_KEY`, and `PAYSTACK_WEBHOOK_SECRET` securely, e.g. Cloud Run Secret Manager references. Set `PUBLIC_BASE_URL` to the HTTPS service origin and register `/webhooks/payments` in Paystack. The initial admin is created only once; changing these values does not reset an existing admin. Startup waits for seeding and fails if Firestore is unavailable. Complete institution setup after startup.
- Sessions are stored in Firestore with a 24-hour expiry, shared across instances; cookies are HttpOnly, SameSite=Lax and Secure in production. Configure a Firestore TTL policy on the `sessions` collection's `expiresAt` field to clean up expired sessions; expiry is enforced even before TTL deletion.
- Build the frontend with `npm run build` and include `fedpolodfel-react/dist` in the backend image. Cloud Run supplies `PORT`. Do not enable mock payments in production. Paystack test-mode checkout and verification are implemented, but this workspace has not been connected to a Paystack account or deployed to staging; complete real test transactions and webhook verification before accepting live payments.
- Admin invoice/reconciliation views currently read and filter invoices in application memory and perform per-invoice lookups; plan pagination/indexing before large-scale use. Protect access to Firestore and monitor reads and costs.

For local emulator testing, start a Firestore emulator separately and set `DATA_STORE=firestore`, `GOOGLE_CLOUD_PROJECT` to a test project ID, and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` (or its actual host and port), with `NODE_ENV` not set to production. SQLite remains the default locally. Neither service-account JSON nor real credentials are needed for the emulator. No deployment is performed by these instructions.

Before launch, replace the starter admission guidance with your institution's approved requirements in `fedpolodfel-react/src/pages/AdmissionRequirementPage.jsx`. The sample program and `.env.example` values are placeholders.

## Project structure

- `app.js`: backend entry point
- `src/data/store.js`: local SQLite persistence
- `src/data/firestore.js` and `src/data/firestore-session.js`: Firestore data and session persistence
- `fedpolodfel-react/src/`: React app pages/components
- `public/`: static assets served by Express
- `docs/schema.sql`: SQL schema draft for RDBMS migration

## License

This project is licensed under the [MIT License](../LICENSE). Bundled third-party files with their own notices remain subject to those notices.
