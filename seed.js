// One-time user setup. Run locally against Railway's PUBLIC database url:
//   DATABASE_URL="postgresql://...public..." DATABASE_SSL=true node seed.js
//
// EDIT the arrays below first: usernames, passwords, and each building's real
// latitude/longitude (right-click the spot in Google Maps to copy coordinates).
// radius_meters is the geofence. With buildings 2km+ apart you can keep it loose
// (300-500). Re-running is safe: existing usernames are updated, not duplicated.

const bcrypt = require("bcryptjs");
const { pool, initSchema } = require("./db");

const MANAGER = {
  username: "rayait",
  password: "raya@@@@",
};

const TECHS = [
  {
    username: "9090",
    password: "9090",
    building_name: "90 Building",
    building_lat: 30.000000, // <-- replace
    building_lng: 31.000000, // <-- replace
    radius_meters: 400,
  },
  {
    username: "7070",
    password: "7070",
    building_name: "70 Building",
    building_lat: 30.010000, // <-- replace
    building_lng: 31.010000, // <-- replace
    radius_meters: 400,
  },
  {
    username: "7878",
    password: "7878",
    building_name: "7 Maadi",
    building_lat: 30.020000, // <-- replace
    building_lng: 31.020000, // <-- replace
    radius_meters: 400,
  },
];

async function upsertUser(u) {
  const hash = await bcrypt.hash(u.password, 10);
  await pool.query(
    `INSERT INTO users
       (username, password_hash, role, building_name, building_lat, building_lng, radius_meters)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = $2, role = $3, building_name = $4,
       building_lat = $5, building_lng = $6, radius_meters = $7`,
    [
      u.username,
      hash,
      u.role,
      u.building_name || null,
      u.building_lat ?? null,
      u.building_lng ?? null,
      u.radius_meters ?? null,
    ]
  );
  console.log("upserted", u.username);
}

(async () => {
  await initSchema();
  await upsertUser({ ...MANAGER, role: "manager" });
  for (const t of TECHS) await upsertUser({ ...t, role: "tech" });
  console.log("done");
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
