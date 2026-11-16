# ODFel Admissions Portal

ODFel is a reusable admissions portal for schools offering open, distance, and
flexible learning. Clone the project, configure your institution's details and
programmes, and publish your approved admission requirements.

## Get started

Requires **Node.js 22.13 or newer** (`node -v`).

The application currently lives in [`fedpolodel/`](./fedpolodel/). Install its
dependencies and start it:

```bash
npm --prefix fedpolodel install
npm --prefix fedpolodel/fedpolodfel-react install
npm --prefix fedpolodel run dev
```

Open <http://localhost:5173>. `npm run dev` starts both the admissions backend
(API on port 3000) and the frontend dev server (port 5173), and stops both on
Ctrl+C.

## Configure for your school

- Copy [`fedpolodel/fedpolodfel-react/.env.example`](./fedpolodel/fedpolodfel-react/.env.example)
  to `.env` in that frontend folder and set the institution name and optional
  contact, logo, and study-mode values.
- Configure programmes, the application fee, and Paystack settings by
  copying [`fedpolodel/backend.env.example`](./fedpolodel/backend.env.example)
  to `fedpolodel/backend.env`. The backend loads it on start. For production,
  keep Paystack credentials in Cloud Run Secret Manager rather than a local
  environment file.
- Replace the starter admission guidance with your school's approved
  requirements before accepting applications.

See the [application README](./fedpolodel/README.md) for backend setup,
deployment, and configuration details.

> **Payments:** The default application fee is a flat NGN 25,000. Development
> uses a local dummy-card gateway; configured deployments use hosted Paystack
> checkout and server-side payment verification. Complete staging checkout and
> webhook tests before accepting live payments. See the
> [application README](./fedpolodel/README.md#payments).

## License

This project is available under the [MIT License](./LICENSE). Bundled
third-party files with their own notices remain subject to those notices.
