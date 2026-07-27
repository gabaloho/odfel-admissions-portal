# ODFEL Local Clone + Admissions Starter

This workspace contains a **static snapshot** of the public pages from:

- <https://odfel.gbokopoly.edu.ng/>

The snapshot is saved in `site-clone/` and is useful for:

- UI/UX reference
- content structure planning
- rebuilding your own portal with your own branding and backend

This repository now also includes a working **Phase 1 admissions starter app** in Node.js.

## Phase 1 features implemented

- Applicant account registration and login
- Session-based authentication
- Pre-application form (program and mode selection)
- Invoice generation and invoice display
- Mock invoice payment action (Pay Now)
- Signed payment webhook endpoint at `/webhooks/payments` (Paystack/Flutterwave style)
- Applicant dashboard (application + latest invoice)
- Local persistent SQLite datastore at `data/app.db`
- SQL schema draft for production migration at `docs/schema.sql`

## Admin payment operations

- Admin login: `/admin/login`
- Admin account management: `/admin/users`
- Payment verification and filtering console: `/admin/payments`
- Reconciliation CSV export: `/admin/payments/export.csv`
- Manual invoice payment status override with notes
- Reconciliation report and auto-reconcile action
- Payment transaction history and audit trail

Admin accounts are now database-backed (`admin_users` table) with role-based permissions:

- `super_admin`: view, override, reconcile
- `finance_admin`: view, override, reconcile
- `auditor`: view-only

Supported admin account actions (super admin):

- Create admin accounts
- Activate/deactivate admin accounts
- Change admin role
- Reset admin password

Admin password security behavior:

- New admin accounts must change password on first login (`/admin/change-password`)
- Admin-reset passwords also force password change at next login
- Password policy: minimum 10 chars, uppercase, lowercase, number, special character
- Password expiry is tracked and enforced

Default local admin credentials:

- Username: `admin`
- Password: `AdminPass123!` (for fresh database seeds)

Set these in production using environment variables:

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `PAYMENT_WEBHOOK_SECRET`

For webhook signature verification:

- Configure `PAYMENT_WEBHOOK_SECRET`
- Paystack style: `x-paystack-signature` HMAC-SHA512 on raw body
- Flutterwave style: `verif-hash` (or `x-flutterwave-signature`) equality check

## What is already done

- A custom crawler script was added at `scripts/clone-site.js`
- Public pages and assets were downloaded to `site-clone/`

## Run locally

1. Install dependencies (already done once):

```bash
npm install
```

1. Start the unified app (recommended):

```bash
npm run unified:start
```

This builds `site-clone-react` and serves it from the same Express process on port 3000 while keeping admissions/admin/payment workflows in the same backend.

1. Start backend process directly:

```bash
npm start
```

This runs the same unified backend server and serves the built React frontend from `site-clone-react/dist`.

Then open:

- <http://127.0.0.1:3000>

1. Re-generate the static snapshot any time:

```bash
npm run clone:odfel
```

1. Serve only the static snapshot for visual reference:

```bash
npx http-server site-clone -p 8080
```

- <http://127.0.0.1:8080>

## Important notes

- The downloaded `.php` pages in `site-clone/` are static snapshots and do not include original server execution logic.
- Forms, login, and payment workflows will not function end-to-end without a backend.
- Replace logos/text/policies with your institution's original content and branding.
- This starter backend currently stores data in SQLite for local development; production should use MySQL or PostgreSQL.
- The local mock pay button is a simulation; signed webhook verification is implemented for production-style integration.

## Suggested rebuild architecture (production)

- Frontend: React/Next.js (or server-rendered PHP/Laravel Blade)
- Backend: Laravel (PHP) or Node.js API
- Database: MySQL/PostgreSQL
- Payments: Paystack/Flutterwave (or your approved processor)
- Admin modules:
  - Program management
  - Applicant review/screening
  - Payment verification
  - Document printing

## Next implementation phases

1. Replace JSON store with MySQL/PostgreSQL using `docs/schema.sql`
2. Add payment gateway integration and callback verification
3. Implement complete application sections and document uploads
4. Build applicant actions: continue application, check status, print slip
5. Build admin dashboard and role-based access control
6. Add email/SMS notifications and audit logs
