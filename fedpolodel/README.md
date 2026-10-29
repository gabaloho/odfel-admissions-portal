# ODFel Admissions Portal

ODFel is a reusable open and distance flexible learning admissions portal. Schools can clone it, configure their own identity and programmes, and publish their approved admission information.

It is a React/Vite portal with optional Node.js/Express backend support.

- React frontend in `fedpolodfel-react/`
- Optional backend entry in `app.js`
- SQLite local datastore in `data/app.db` (backend mode)
- Admin and payment workflows available in backend mode

## Current features

- Applicant registration and login
- Session-based authentication
- Pre-application flow
- Invoice generation and invoice view
- Local mock payment flow for development
- Applicant dashboard
- Check status and print document pages
- Admin login and role-based access
- Admin user management (`/admin/users`)
- Admin payment verification console (`/admin/payments`)
- Manual payment override with audit trail
- Reconciliation report and CSV export
- Signed payment webhook verification (`/webhooks/payments`)

## Admin roles

- `super_admin`: full access (users + payments)
- `finance_admin`: payment operations access
- `auditor`: payment view access

Default local admin credentials (for fresh local seed):

- Username: `admin`
- Password: `AdminPass123!`

## Environment variables

Copy `fedpolodfel-react/.env.example` to `fedpolodfel-react/.env` and set your institution's details before building the frontend:

- `VITE_INSTITUTION_NAME`
- `VITE_INSTITUTION_WEBSITE` (optional; must use HTTP or HTTPS)
- `VITE_INSTITUTION_EMAIL` (optional)
- `VITE_INSTITUTION_PHONE` (optional)
- `VITE_INSTITUTION_ADDRESS` (optional)
- `VITE_INSTITUTION_LOGO` (optional root-relative path or HTTP/HTTPS URL)
- `VITE_MODES_OF_STUDY` (comma-separated; defaults to full-time, part-time, and distance learning)

Use `backend.env.example` as a reference for server configuration. Set `PROGRAMS_JSON` to a non-empty JSON array of objects with unique `id` and `name` values, for example:

```json
[{"id":"undergraduate","name":"Undergraduate Programme"},{"id":"postgraduate","name":"Postgraduate Programme"}]
```

Programs are seeded into SQLite only when the programs table is empty. Set this variable before the first backend start; for an existing local database, migrate or clear its program data deliberately before reseeding.

Set the school's `APPLICATION_FEE_AMOUNT`, `APPLICATION_FEE_CURRENCY` (three-letter code), and optionally `APPLICATION_FEE_DESCRIPTION`. The development default is a free USD invoice; production startup requires an explicit fee amount. Set it to `0` only when applications are free.

The included "Pay Now" action is a local mock, not a live payment gateway. Integrate and verify your payment provider before accepting real payments; webhook signature validation currently supports Paystack and Flutterwave.

Also set these for production:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `PAYMENT_WEBHOOK_SECRET`

Webhook signature handling:

- Paystack: validates `x-paystack-signature` using HMAC-SHA512 raw body hash
- Flutterwave: validates `verif-hash` / `x-flutterwave-signature`

## Local development

1. Install root dependencies:

```bash
npm install
```

2. Install frontend dependencies:

```bash
npm --prefix fedpolodfel-react install
```

3. Run frontend development server (default):

```bash
npm run dev
```

4. Open:

- <http://127.0.0.1:5173>

## Build and preview

Build frontend bundle:

```bash
npm run build
```

Preview production bundle locally:

```bash
npm run preview
```

## Optional backend mode

Run Express backend if you need server-side admissions/admin/payment endpoints:

```bash
npm run backend:start
```

## Deployment

- Repository includes `vercel.json` for frontend deployment workflow.
- Frontend output directory: `fedpolodfel-react/dist`

Note: The backend uses sessions and SQLite. For full production deployment, run backend on a server platform and migrate to MySQL/PostgreSQL.

Before launch, replace the starter admission guidance with your institution's approved requirements in `fedpolodfel-react/src/pages/AdmissionRequirementPage.jsx`. The sample program and `.env.example` values are placeholders.

## Project structure

- `app.js`: backend entry point
- `src/data/store.js`: data access and persistence logic
- `fedpolodfel-react/src/`: React app pages/components
- `public/`: static assets served by Express
- `docs/schema.sql`: SQL schema draft for RDBMS migration

## License

This project is licensed under the [MIT License](../LICENSE). Bundled third-party files with their own notices remain subject to those notices.
