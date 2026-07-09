const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDb, query } = require('./config/db');
const authRoutes = require('./routes/auth');
const medicineRoutes = require('./routes/medicines');
const requestRoutes = require('./routes/requests');
const notificationRoutes = require('./routes/notifications');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/reports');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS & JSON Parsing
app.use(cors());
app.use(express.json());

// Ensure Uploads Directory Exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/medicines', medicineRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);

// Serve Static Frontend files in production
const frontendBuildPath = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('MediShare API is running. Build frontend to serve web application.');
  });
}

// Automated Expiry Monitoring Service
const checkExpiryDatesAndNotify = async () => {
  console.log('Running scheduled check: Medicine Expiry Monitor...');
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all approved medicines in stock
    const medicines = await query(
      `SELECT m.*, u.full_name as donor_name 
       FROM medicines m 
       JOIN users u ON m.donor_id = u.user_id
       WHERE m.status = 'approved' AND m.quantity > 0`
    );

    // Get all NGO and Admin users to send alerts to
    const staff = await query('SELECT user_id FROM users WHERE role IN ("ngo", "admin")');
    if (staff.length === 0) return;

    for (const med of medicines) {
      const expDate = new Date(med.expiry_date);
      const diffTime = expDate.getTime() - today.getTime();
      const daysToExpiry = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let alertLevel = null;
      let alertMessage = '';

      if (daysToExpiry <= 0) {
        // Already expired
        alertLevel = 'Expired';
        alertMessage = `CRITICAL: Medicine "${med.medicine_name}" (Batch: ${med.batch_number}) has expired! Please remove from active inventory.`;
        
        // Update status in db to avoid repeated alerts
        await query('UPDATE medicines SET status = "rejected", verification_remarks = "Expired during inventory monitoring" WHERE medicine_id = ?', [med.medicine_id]);
      } else if (daysToExpiry <= 30) {
        // Red alert
        alertLevel = 'Red (Critical)';
        alertMessage = `Medicine "${med.medicine_name}" (Batch: ${med.batch_number}) expires in ${daysToExpiry} days. Priority distribution required.`;
      } else if (daysToExpiry <= 90) {
        // Yellow alert
        alertLevel = 'Yellow (Warning)';
        alertMessage = `Medicine "${med.medicine_name}" (Batch: ${med.batch_number}) expires in ${daysToExpiry} days.`;
      }

      if (alertLevel) {
        // Send notification to all staff (NGO and Admin)
        for (const person of staff) {
          // Check if notification already exists for this medicine and level to prevent duplication
          const exists = await query(
            'SELECT * FROM notifications WHERE user_id = ? AND title = ? AND message = ?',
            [person.user_id, `Expiry Alert: ${alertLevel}`, alertMessage]
          );

          if (exists.length === 0) {
            const crypto = require('crypto');
            const notificationId = crypto.randomUUID();
            await query(
              'INSERT INTO notifications (notification_id, user_id, title, message) VALUES (?, ?, ?, ?)',
              [notificationId, person.user_id, `Expiry Alert: ${alertLevel}`, alertMessage]
            );
          }
        }
      }
    }
    console.log('Expiry Monitor check completed.');
  } catch (err) {
    console.error('Error during expiry check:', err);
  }
};

// Start Server and Connect Database
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  try {
    await initDb();
    console.log('Database connected successfully.');

    // Run initial expiry check immediately on startup
    await checkExpiryDatesAndNotify();

    // Schedule check every 24 hours
    setInterval(checkExpiryDatesAndNotify, 24 * 60 * 60 * 1000);
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
});
