const express = require("express");
const cors = require("cors");
const multer = require("multer");
const bcrypt = require("bcryptjs");

const { pool, initSchema } = require("./db");
const {
  cairoNow,
  toCairoTime,
  parseCutoffMinutes,
  distanceMeters,
  newToken,
} = require("./helpers");

const app = express();
app.use(express.json());

// CORS: only allow your GitHub Pages origin. Set ALLOWED_ORIGIN in Railway.
// Example: https://yourname.github.io
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(
  cors({
    origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(","),
  })
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }, // 6 MB safety cap
});

const CUTOFF = parseCutoffMinutes(process.env.LATE_AFTER); // e.g. "09:30"
const SESSION_DAYS = parseInt(process.env.SESSION_DAYS || "30", 10);

// ---- Lazy photo purge: any request on a new day wipes yesterday's photos ----
async function purgeOldPhotos() {
  const { date } = cairoNow();
  await pool.query(
    `UPDATE checkins SET photo = NULL, photo_mime = NULL
     WHERE checkin_date < $1 AND photo IS NOT NULL`,
    [date]
  );
}

// ---- Auth middleware ----
async function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });

  const { rows } = await pool.query(
    `SELECT s.token, s.expires_at, u.id, u.username, u.role,
            u.building_name, u.building_lat, u.building_lng, u.radius_meters
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );
  if (rows.length === 0) return res.status(401).json({ error: "bad_token" });
  const s = rows[0];
  if (new Date(s.expires_at) < new Date()) {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
    return res.status(401).json({ error: "expired" });
  }
  req.user = s;
  next();
}

function requireManager(req, res, next) {
  if (req.user.role !== "manager")
    return res.status(403).json({ error: "manager_only" });
  next();
}

// ---- Routes ----
app.get("/", (req, res) => res.json({ ok: true, service: "attendance" }));

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "missing_fields" });

  const { rows } = await pool.query(
    `SELECT * FROM users WHERE username = $1`,
    [username]
  );
  if (rows.length === 0)
    return res.status(401).json({ error: "invalid_credentials" });

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, user.id, expires]
  );

  await purgeOldPhotos();

  res.json({
    token,
    role: user.role,
    username: user.username,
    building: user.building_name,
  });
});

app.get("/api/me", auth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    building: req.user.building_name,
  });
});

app.post("/api/logout", auth, async (req, res) => {
  const token = req.headers.authorization.slice(7);
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
  res.json({ ok: true });
});

// ---- Technician check-in ----
app.post("/api/checkin", auth, upload.single("photo"), async (req, res) => {
  if (req.user.role !== "tech")
    return res.status(403).json({ error: "tech_only" });
  if (!req.file) return res.status(400).json({ error: "photo_required" });

  const lat = parseFloat(req.body.lat);
  const lng = parseFloat(req.body.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng))
    return res.status(400).json({ error: "location_required" });

  const { date, minutes } = cairoNow();

  // Already got a valid (in-range) check-in today? First valid one wins.
  const existing = await pool.query(
    `SELECT id, status, server_ts FROM checkins
     WHERE user_id = $1 AND checkin_date = $2`,
    [req.user.id, date]
  );
  if (
    existing.rows.length > 0 &&
    ["on_time", "late"].includes(existing.rows[0].status)
  ) {
    return res.status(409).json({
      error: "already_checked_in",
      status: existing.rows[0].status,
      time: toCairoTime(existing.rows[0].server_ts),
    });
  }

  const dist = distanceMeters(
    lat,
    lng,
    req.user.building_lat,
    req.user.building_lng
  );
  const inRange = dist <= req.user.radius_meters;
  const status = inRange ? (minutes > CUTOFF ? "late" : "on_time") : "out_of_range";

  // Insert, or overwrite a previous out_of_range attempt.
  await pool.query(
    `INSERT INTO checkins
       (user_id, checkin_date, server_ts, lat, lng, distance_meters, status, photo, photo_mime)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, checkin_date) DO UPDATE
       SET server_ts = now(), lat = $3, lng = $4, distance_meters = $5,
           status = $6, photo = $7, photo_mime = $8`,
    [
      req.user.id,
      date,
      lat,
      lng,
      Math.round(dist),
      status,
      req.file.buffer,
      req.file.mimetype,
    ]
  );

  res.json({
    status,
    inRange,
    distanceMeters: Math.round(dist),
    time: cairoNow().time,
  });
});

// ---- Manager: today ----
app.get("/api/manager/today", auth, requireManager, async (req, res) => {
  await purgeOldPhotos();
  const { date, time } = cairoNow();

  const holiday = await pool.query(
    `SELECT description FROM holidays WHERE holiday_date = $1`,
    [date]
  );

  const techs = await pool.query(
    `SELECT id, username, building_name FROM users WHERE role = 'tech' ORDER BY username`
  );

  const result = [];
  for (const t of techs.rows) {
    const onLeave = await pool.query(
      `SELECT 1 FROM leaves WHERE user_id = $1 AND leave_date = $2`,
      [t.id, date]
    );
    const c = await pool.query(
      `SELECT id, status, server_ts, distance_meters, photo IS NOT NULL AS has_photo
       FROM checkins WHERE user_id = $1 AND checkin_date = $2`,
      [t.id, date]
    );

    let status;
    if (holiday.rows.length > 0) status = "holiday";
    else if (onLeave.rows.length > 0) status = "leave";
    else if (c.rows.length > 0) status = c.rows[0].status;
    else status = "absent";

    result.push({
      username: t.username,
      building: t.building_name,
      status,
      time: c.rows.length > 0 ? toCairoTime(c.rows[0].server_ts) : null,
      distance: c.rows.length > 0 ? c.rows[0].distance_meters : null,
      photoId:
        c.rows.length > 0 && c.rows[0].has_photo ? c.rows[0].id : null,
    });
  }

  res.json({
    date,
    now: time,
    holiday: holiday.rows.length > 0 ? holiday.rows[0].description || "Holiday" : null,
    techs: result,
  });
});

// ---- Manager: photo (only today's survives) ----
app.get("/api/manager/photo/:id", auth, requireManager, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT photo, photo_mime FROM checkins WHERE id = $1`,
    [parseInt(req.params.id, 10)]
  );
  if (rows.length === 0 || !rows[0].photo)
    return res.status(404).json({ error: "no_photo" });
  res.set("Content-Type", rows[0].photo_mime || "image/jpeg");
  res.send(rows[0].photo);
});

// ---- Manager: history (last N months, no photos) ----
app.get("/api/manager/history", auth, requireManager, async (req, res) => {
  const months = Math.min(parseInt(req.query.months || "3", 10), 12);
  const { date } = cairoNow();
  const from = new Date(date);
  from.setMonth(from.getMonth() - months);
  const fromStr = from.toISOString().slice(0, 10);

  const techs = await pool.query(
    `SELECT id, username, building_name FROM users WHERE role = 'tech' ORDER BY username`
  );
  const checkins = await pool.query(
    `SELECT user_id, to_char(checkin_date,'YYYY-MM-DD') AS date, status
     FROM checkins WHERE checkin_date >= $1`,
    [fromStr]
  );
  const holidays = await pool.query(
    `SELECT to_char(holiday_date,'YYYY-MM-DD') AS date, description
     FROM holidays WHERE holiday_date >= $1`,
    [fromStr]
  );
  const leaves = await pool.query(
    `SELECT user_id, to_char(leave_date,'YYYY-MM-DD') AS date
     FROM leaves WHERE leave_date >= $1`,
    [fromStr]
  );

  res.json({
    from: fromStr,
    to: date,
    techs: techs.rows.map((t) => ({
      id: t.id,
      username: t.username,
      building: t.building_name,
    })),
    checkins: checkins.rows,
    holidays: holidays.rows,
    leaves: leaves.rows,
  });
});

// ---- Manager: holidays ----
app.post("/api/manager/holiday", auth, requireManager, async (req, res) => {
  const { date, description } = req.body || {};
  if (!date) return res.status(400).json({ error: "date_required" });
  await pool.query(
    `INSERT INTO holidays (holiday_date, description) VALUES ($1, $2)
     ON CONFLICT (holiday_date) DO UPDATE SET description = $2`,
    [date, description || null]
  );
  res.json({ ok: true });
});

app.delete("/api/manager/holiday", auth, requireManager, async (req, res) => {
  const { date } = req.body || {};
  if (!date) return res.status(400).json({ error: "date_required" });
  await pool.query(`DELETE FROM holidays WHERE holiday_date = $1`, [date]);
  res.json({ ok: true });
});

// ---- Manager: per-person leave ----
app.post("/api/manager/leave", auth, requireManager, async (req, res) => {
  const { username, date } = req.body || {};
  if (!username || !date)
    return res.status(400).json({ error: "missing_fields" });
  const u = await pool.query(`SELECT id FROM users WHERE username = $1`, [
    username,
  ]);
  if (u.rows.length === 0) return res.status(404).json({ error: "no_user" });
  await pool.query(
    `INSERT INTO leaves (user_id, leave_date) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [u.rows[0].id, date]
  );
  res.json({ ok: true });
});

app.delete("/api/manager/leave", auth, requireManager, async (req, res) => {
  const { username, date } = req.body || {};
  if (!username || !date)
    return res.status(400).json({ error: "missing_fields" });
  const u = await pool.query(`SELECT id FROM users WHERE username = $1`, [
    username,
  ]);
  if (u.rows.length === 0) return res.status(404).json({ error: "no_user" });
  await pool.query(
    `DELETE FROM leaves WHERE user_id = $1 AND leave_date = $2`,
    [u.rows[0].id, date]
  );
  res.json({ ok: true });
});

// ---- Manager: reset a technician password ----
app.post(
  "/api/manager/reset-password",
  auth,
  requireManager,
  async (req, res) => {
    const { username, newPassword } = req.body || {};
    if (!username || !newPassword)
      return res.status(400).json({ error: "missing_fields" });
    const hash = await bcrypt.hash(newPassword, 10);
    const r = await pool.query(
      `UPDATE users SET password_hash = $1 WHERE username = $2`,
      [hash, username]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "no_user" });
    res.json({ ok: true });
  }
);

const PORT = process.env.PORT || 3000;
initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`listening on ${PORT}`));
  })
  .catch((e) => {
    console.error("schema init failed", e);
    process.exit(1);
  });
