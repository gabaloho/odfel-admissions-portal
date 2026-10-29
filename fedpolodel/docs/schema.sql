-- Phase 1 relational schema draft for production migration

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY,
  surname VARCHAR(100) NOT NULL,
  other_names VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL
);

CREATE TABLE programs (
  id VARCHAR(60) PRIMARY KEY,
  name VARCHAR(190) NOT NULL
);

CREATE TABLE applications (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  program_id VARCHAR(60) NOT NULL,
  mode_of_study VARCHAR(40) NOT NULL,
  previous_institution VARCHAR(190) NOT NULL,
  notes TEXT,
  status VARCHAR(60) NOT NULL DEFAULT 'Pending Screening',
  submitted_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  CONSTRAINT fk_applications_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_applications_program FOREIGN KEY (program_id) REFERENCES programs(id)
);

CREATE TABLE invoices (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  invoice_number VARCHAR(60) NOT NULL UNIQUE,
  amount DECIMAL(12,2) NOT NULL,
  fee_description VARCHAR(190) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  payment_status VARCHAR(40) NOT NULL DEFAULT 'Unpaid',
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_invoices_user FOREIGN KEY (user_id) REFERENCES users(id)
);
