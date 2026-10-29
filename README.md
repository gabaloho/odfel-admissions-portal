# ODFel Admissions Portal

ODFel is a reusable admissions portal for schools offering open, distance, and
flexible learning. Clone the project, configure your institution's details and
programmes, and publish your approved admission requirements.

## Get started

The application currently lives in [`fedpolodel/`](./fedpolodel/). Install its
dependencies and start the frontend:

```bash
npm --prefix fedpolodel install
npm --prefix fedpolodel/fedpolodfel-react install
npm --prefix fedpolodel run dev
```

Open <http://127.0.0.1:5173>.

## Configure for your school

- Copy [`fedpolodel/fedpolodfel-react/.env.example`](./fedpolodel/fedpolodfel-react/.env.example)
  to `.env` in that frontend folder and set the institution name and optional
  contact, logo, and study-mode values.
- Configure programmes and application fees using
  [`fedpolodel/backend.env.example`](./fedpolodel/backend.env.example).
- Replace the starter admission guidance with your school's approved
  requirements before accepting applications.

See the [application README](./fedpolodel/README.md) for backend setup,
deployment, and configuration details.

> **Payments:** The included “Pay Now” flow is a local mock, not a live payment
> integration. Integrate and verify a payment provider before accepting real
> payments.

## License

This project is available under the [MIT License](./LICENSE). Bundled
third-party files with their own notices remain subject to those notices.
