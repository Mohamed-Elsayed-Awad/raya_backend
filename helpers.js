const crypto = require("crypto");

const TZ = process.env.TZ_NAME || "Africa/Cairo";

// Current wall-clock in the configured timezone, independent of the server's own TZ.
function cairoNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = get("hour");
  if (hour === "24") hour = "00"; // some runtimes emit 24 at midnight
  const minute = get("minute");
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);
  return { date, time: `${hour}:${minute}`, minutes };
}

// Format a stored timestamptz to HH:MM in the configured timezone.
function toCairoTime(tsValue) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(tsValue));
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${hour}:${get("minute")}`;
}

// "09:30" -> 570
function parseCutoffMinutes(str) {
  const [h, m] = (str || "09:30").split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = {
  cairoNow,
  toCairoTime,
  parseCutoffMinutes,
  distanceMeters,
  newToken,
};
