// server.js
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

// ─────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Serve Admin Dashboard ──────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
//  MongoDB
// ─────────────────────────────────────────────
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/device_monitor';

mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB error:', err));

// ─────────────────────────────────────────────
//  Schemas & Models
// ─────────────────────────────────────────────

// Device
const deviceSchema = new mongoose.Schema(
  {
    device_id: { type: String, required: true, unique: true, index: true },
    device_name: { type: String, default: 'Unknown' },
    first_seen: { type: Date, default: Date.now },
    last_seen: { type: Date, default: Date.now },
    total_events: { type: Number, default: 0 },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: true }
);
const Device = mongoose.model('Device', deviceSchema);

// Call Event
const callSchema = new mongoose.Schema(
  {
    event_key:  { type: String, unique: true, sparse: true }, // dedup
    device_id:  { type: String, required: true, index: true },
    device_name:{ type: String, default: 'Unknown' },
    title:      { type: String, required: true },
    body:       { type: String, default: '' },
    timestamp:  { type: Date, default: Date.now, index: true },
    received_at:{ type: Date, default: Date.now },
  },
  { timestamps: true }
);
callSchema.index({ device_id: 1, timestamp: -1 });
const CallEvent = mongoose.model('CallEvent', callSchema);

// SMS Event
const smsSchema = new mongoose.Schema(
  {
    event_key:  { type: String, unique: true, sparse: true }, // dedup
    device_id:  { type: String, required: true, index: true },
    device_name:{ type: String, default: 'Unknown' },
    title:      { type: String, required: true },
    body:       { type: String, default: '' },
    timestamp:  { type: Date, default: Date.now, index: true },
    received_at:{ type: Date, default: Date.now },
  },
  { timestamps: true }
);
smsSchema.index({ device_id: 1, timestamp: -1 });
const SmsEvent = mongoose.model('SmsEvent', smsSchema);

// Notification Event
const notificationSchema = new mongoose.Schema(
  {
    event_key:   { type: String, unique: true, sparse: true }, // dedup
    device_id:   { type: String, required: true, index: true },
    device_name: { type: String, default: 'Unknown' },
    package_name:{ type: String, required: true },
    title:       { type: String, default: '' },
    content:     { type: String, default: '' },
    timestamp:   { type: Date, default: Date.now, index: true },
    received_at: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
notificationSchema.index({ device_id: 1, timestamp: -1 });
notificationSchema.index({ package_name: 1 });
const NotificationEvent = mongoose.model('NotificationEvent', notificationSchema);

// ─────────────────────────────────────────────
//  Auth Middleware
// ─────────────────────────────────────────────
const API_KEY = process.env.API_KEY || 'your-secret-api-key';

const auth = (req, res, next) => {
  const key = req.headers['authorization']?.replace('Bearer ', '');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// ─────────────────────────────────────────────
//  Helper: update device record
// ─────────────────────────────────────────────
async function touchDevice(device_id, device_name) {
  await Device.findOneAndUpdate(
    { device_id },
    {
      $set: { last_seen: new Date(), device_name, is_active: true },
      $inc: { total_events: 1 },
      $setOnInsert: { device_id, first_seen: new Date() },
    },
    { upsert: true, new: true }
  );
}

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────

// Health check (JSON) – at /api/health so static index.html can serve at /
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: '🚀 Device Monitor Server is running',
    version: '2.0.0',
    timestamp: new Date(),
  });
});

// ── CALL ──────────────────────────────────────
// POST /api/events/call
app.post('/api/events/call', auth, async (req, res) => {
  try {
    const { device_id, device_name, title, body, timestamp, event_key } = req.body;
    if (!device_id || !title)
      return res.status(400).json({ success: false, message: 'device_id and title are required' });

    // Duplicate check — if event_key exists, skip silently
    if (event_key) {
      const existing = await CallEvent.findOne({ event_key });
      if (existing) return res.status(200).json({ success: true, duplicate: true, data: existing });
    }

    const doc = await CallEvent.create({
      event_key:   event_key || null,
      device_id,
      device_name: device_name || 'Unknown',
      title,
      body: body || '',
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await touchDevice(device_id, device_name || 'Unknown');
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.code === 11000) // MongoDB duplicate key
      return res.status(200).json({ success: true, duplicate: true });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/call  (with ?device_id=&page=&limit=)
app.get('/api/events/call', auth, async (req, res) => {
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
app.delete('/api/events/call', auth, async (req, res) => {
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
app.post('/api/events/sms', auth, async (req, res) => {
  try {
    const { device_id, device_name, title, body, timestamp, event_key } = req.body;
    if (!device_id || !title)
      return res.status(400).json({ success: false, message: 'device_id and title are required' });

    if (event_key) {
      const existing = await SmsEvent.findOne({ event_key });
      if (existing) return res.status(200).json({ success: true, duplicate: true, data: existing });
    }

    const doc = await SmsEvent.create({
      event_key:   event_key || null,
      device_id,
      device_name: device_name || 'Unknown',
      title,
      body: body || '',
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await touchDevice(device_id, device_name || 'Unknown');
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.code === 11000)
      return res.status(200).json({ success: true, duplicate: true });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/sms
app.get('/api/events/sms', auth, async (req, res) => {
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
app.delete('/api/events/sms', auth, async (req, res) => {
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
// POST /api/events/notification
app.post('/api/events/notification', auth, async (req, res) => {
  try {
    const { device_id, device_name, package_name, title, content, timestamp, event_key } = req.body;

    if (!device_id || !package_name)
      return res.status(400).json({ success: false, message: 'device_id and package_name are required' });

    if (event_key) {
      const existing = await NotificationEvent.findOne({ event_key });
      if (existing) return res.status(200).json({ success: true, duplicate: true, data: existing });
    }

    const doc = await NotificationEvent.create({
      event_key:   event_key || null,
      device_id,
      device_name: device_name || 'Unknown',
      package_name,
      title:   title || '',
      content: content || '',
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    });

    await touchDevice(device_id, device_name || 'Unknown');
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.code === 11000)
      return res.status(200).json({ success: true, duplicate: true });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/events/notification
app.get('/api/events/notification', auth, async (req, res) => {
  try {
    const {
      device_id,
      package_name,
      page = 1,
      limit = 50,
    } = req.query;
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

// DELETE /api/events/notification
app.delete('/api/events/notification', auth, async (req, res) => {
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
app.get('/api/devices', auth, async (req, res) => {
  try {
    const devices = await Device.find().sort({ last_seen: -1 });
    res.json({ success: true, count: devices.length, data: devices });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/devices/:device_id  – full summary for one device
app.get('/api/devices/:device_id', auth, async (req, res) => {
  try {
    const { device_id } = req.params;
    const device = await Device.findOne({ device_id });
    if (!device)
      return res.status(404).json({ success: false, message: 'Device not found' });

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
app.delete('/api/devices/:device_id', auth, async (req, res) => {
  try {
    const { device_id } = req.params;
    await Promise.all([
      CallEvent.deleteMany({ device_id }),
      SmsEvent.deleteMany({ device_id }),
      NotificationEvent.deleteMany({ device_id }),
      Device.deleteOne({ device_id }),
    ]);
    res.json({ success: true, message: 'Device and all its data deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── STATS / ANALYTICS ─────────────────────────
// GET /api/stats
app.get('/api/stats', auth, async (req, res) => {
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
        { $group: { _id: '$package_name', count: { $sum: 1 } } },
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
app.get('/api/analytics/daily', auth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const fmt = '%Y-%m-%d';
    const matchStage = { received_at: { $gte: startDate } };
    const groupStage = {
      _id: { $dateToString: { format: fmt, date: '$received_at' } },
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
app.get('/api/search', auth, async (req, res) => {
  try {
    const { q, type = 'all', device_id } = req.query;
    if (!q)
      return res
        .status(400)
        .json({ success: false, message: 'Query param q is required' });

    const regex = { $regex: q, $options: 'i' };
    const deviceFilter = device_id ? { device_id } : {};
    const limit = 50;

    const results = {};

    if (type === 'all' || type === 'call') {
      results.calls = await CallEvent.find({
        ...deviceFilter,
        $or: [{ title: regex }, { body: regex }],
      })
        .sort({ timestamp: -1 })
        .limit(limit);
    }

    if (type === 'all' || type === 'sms') {
      results.sms = await SmsEvent.find({
        ...deviceFilter,
        $or: [{ title: regex }, { body: regex }],
      })
        .sort({ timestamp: -1 })
        .limit(limit);
    }

    if (type === 'all' || type === 'notification') {
      results.notifications = await NotificationEvent.find({
        ...deviceFilter,
        $or: [
          { title: regex },
          { content: regex },
          { package_name: regex },
        ],
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
//  Error handlers
// ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
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