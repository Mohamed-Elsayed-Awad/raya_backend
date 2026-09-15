const { Pool } = require("pg");

// DATABASE_SSL=true when connecting over Railway's PUBLIC url (e.g. running seed.js
// from your laptop). Leave it unset when the backend runs ON Railway and uses the
// INTERNAL url, which is plain TCP and rejects SSL.
const useSSL = process.env.DATABASE_SSL === "true";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'tech',
      building_name TEXT,
      building_lat DOUBLE PRECISION,
      building_lng DOUBLE PRECISION,
      radius_meters INTEGER DEFAULT 300
    );

    CREATE TABLE IF NOT EXISTS checkins (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      checkin_date DATE NOT NULL,
      server_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      distance_meters INTEGER,
      status TEXT NOT NULL,
      photo BYTEA,
      photo_mime TEXT,
      UNIQUE (user_id, checkin_date)
    );

    CREATE TABLE IF NOT EXISTS holidays (
      holiday_date DATE PRIMARY KEY,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS leaves (
      user_id INTEGER NOT NULL REFERENCES users(id),
      leave_date DATE NOT NULL,
      PRIMARY KEY (user_id, leave_date)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
}

module.exports = { pool, initSchema };
