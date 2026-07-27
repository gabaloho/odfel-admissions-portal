# Federal Polytechnic Wannune Admissions Portal

This repository contains the current Federal Polytechnic Wannune admissions project.

It is a React/Vite-first portal with optional Node.js/Express backend support.

- React frontend in `fedpolodfel-react/`
- Optional backend entry in `app.js`
- SQLite local datastore in `data/app.db` (backend mode)
- Admin and payment workflows available in backend mode

## Current features

- Applicant registration and login
- Session-based authentication
- Pre-application flow
- Invoice generation and invoice view
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

Set these for production:

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

## Project structure

- `app.js`: backend entry point
- `src/data/store.js`: data access and persistence logic
- `views/`: server-rendered admin/auth templates
- `fedpolodfel-react/src/`: React app pages/components
- `public/`: static assets served by Express
- `docs/schema.sql`: SQL schema draft for RDBMS migration
