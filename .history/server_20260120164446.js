// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ⚙️ Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 📊 MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/notification_db';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB Connected Successfully'))
.catch((err) => console.error('❌ MongoDB Connection Error:', err));

// 📱 Notification Schema
const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  package_name: {
    type: String,
    required: true,
    trim: true
  },
  device_id: {
    type: String,
    required: true,
    index: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  received_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true // createdAt, updatedAt automatically add hoga
});

// Index for better query performance
notificationSchema.index({ device_id: 1, timestamp: -1 });
notificationSchema.index({ package_name: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

// 📱 Device Schema (Track registered devices)
const deviceSchema = new mongoose.Schema({
  device_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  device_name: String,
  first_seen: {
    type: Date,
    default: Date.now
  },
  last_seen: {
    type: Date,
    default: Date.now
  },
  total_notifications: {
    type: Number,
    default: 0
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

const Device = mongoose.model('Device', deviceSchema);

// 🔐 Simple API Key Authentication Middleware (Optional)
const API_KEY = process.env.API_KEY || 'your-secret-api-key';

const authenticateAPI = (req, res, next) => {
  const apiKey = req.headers['authorization']?.replace('Bearer ', '');
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid API Key'
    });
  }
  
  next();
};

// 🌐 Routes

// Health Check
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Notification Server is running!',
    version: '1.0.0',
    timestamp: new Date()
  });
});

// 📤 POST - Upload Notification
app.post('/api/notifications', authenticateAPI, async (req, res) => {
  try {
    const { title, content, package_name, device_id, timestamp } = req.body;

    // Validation
    if (!title || !content || !package_name || !device_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: title, content, package_name, device_id'
      });
    }

    // Create notification
    const notification = new Notification({
      title,
      content,
      package_name,
      device_id,
      timestamp: timestamp ? new Date(timestamp) : new Date()
    });

    await notification.save();

    // Update device info
    await Device.findOneAndUpdate(
      { device_id },
      {
        $set: { last_seen: new Date() },
        $inc: { total_notifications: 1 },
        $setOnInsert: { 
          device_id,
          first_seen: new Date(),
          is_active: true
        }
      },
      { upsert: true, new: true }
    );

    res.status(201).json({
      success: true,
      message: 'Notification saved successfully',
      data: notification
    });

  } catch (error) {
    console.error('Error saving notification:', error);
    res.status(500).json({
      success: false,
      message: 'Error saving notification',
      error: error.message
    });
  }
});

// 📥 GET - Get All Notifications (with pagination)
app.get('/api/notifications', authenticateAPI, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const device_id = req.query.device_id;
    const package_name = req.query.package_name;

    const skip = (page - 1) * limit;

    // Build query
    let query = {};
    if (device_id) query.device_id = device_id;
    if (package_name) query.package_name = package_name;

    const notifications = await Notification.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Notification.countDocuments(query);

    res.json({
      success: true,
      data: notifications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching notifications',
      error: error.message
    });
  }
});

// 📊 GET - Get Notifications by Device ID
app.get('/api/notifications/device/:device_id', authenticateAPI, async (req, res) => {
  try {
    const { device_id } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    const notifications = await Notification.find({ device_id })
      .sort({ timestamp: -1 })
      .limit(limit);

    res.json({
      success: true,
      device_id,
      count: notifications.length,
      data: notifications
    });

  } catch (error) {
    console.error('Error fetching device notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching device notifications',
      error: error.message
    });
  }
});

// 📊 GET - Analytics/Stats
app.get('/api/stats', authenticateAPI, async (req, res) => {
  try {
    const totalNotifications = await Notification.countDocuments();
    const totalDevices = await Device.countDocuments();
    const activeDevices = await Device.countDocuments({ is_active: true });

    // Last 24 hours notifications
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentNotifications = await Notification.countDocuments({
      received_at: { $gte: last24Hours }
    });

    // Top apps by notification count
    const topApps = await Notification.aggregate([
      {
        $group: {
          _id: '$package_name',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    // Notifications per device
    const notificationsPerDevice = await Notification.aggregate([
      {
        $group: {
          _id: '$device_id',
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } }
    ]);

    res.json({
      success: true,
      stats: {
        total_notifications: totalNotifications,
        total_devices: totalDevices,
        active_devices: activeDevices,
        notifications_24h: recentNotifications,
        top_apps: topApps,
        notifications_per_device: notificationsPerDevice
      }
    });

  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching stats',
      error: error.message
    });
  }
});

// 📱 GET - All Devices
app.get('/api/devices', authenticateAPI, async (req, res) => {
  try {
    const devices = await Device.find().sort({ last_seen: -1 });

    res.json({
      success: true,
      count: devices.length,
      data: devices
    });

  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching devices',
      error: error.message
    });
  }
});

// 🗑️ DELETE - Delete Notification by ID
app.delete('/api/notifications/:id', authenticateAPI, async (req, res) => {
  try {
    const { id } = req.params;

    const notification = await Notification.findByIdAndDelete(id);

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting notification',
      error: error.message
    });
  }
});

// 🗑️ DELETE - Delete All Notifications for a Device
app.delete('/api/notifications/device/:device_id', authenticateAPI, async (req, res) => {
  try {
    const { device_id } = req.params;

    const result = await Notification.deleteMany({ device_id });

    res.json({
      success: true,
      message: `${result.deletedCount} notifications deleted`,
      deleted_count: result.deletedCount
    });

  } catch (error) {
    console.error('Error deleting notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting notifications',
      error: error.message
    });
  }
});

// 🔍 GET - Search Notifications
app.get('/api/notifications/search', authenticateAPI, async (req, res) => {
  try {
    const { q, device_id } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        message: 'Search query (q) is required'
      });
    }

    let query = {
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { content: { $regex: q, $options: 'i' } },
        { package_name: { $regex: q, $options: 'i' } }
      ]
    };

    if (device_id) {
      query.device_id = device_id;
    }

    const notifications = await Notification.find(query)
      .sort({ timestamp: -1 })
      .limit(100);

    res.json({
      success: true,
      count: notifications.length,
      data: notifications
    });

  } catch (error) {
    console.error('Error searching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching notifications',
      error: error.message
    });
  }
});

// 📊 GET - Notifications Count by Date
app.get('/api/analytics/daily', authenticateAPI, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const dailyStats = await Notification.aggregate([
      {
        $match: {
          received_at: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$received_at' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      period: `Last ${days} days`,
      data: dailyStats
    });

  } catch (error) {
    console.error('Error fetching daily analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching daily analytics',
      error: error.message
    });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 🚀 Start Server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 MongoDB URI: ${MONGODB_URI}`);
  console.log(`🔐 API Key: ${API_KEY}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});