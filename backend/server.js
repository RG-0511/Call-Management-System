// --- Required Libraries ---
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const bcrypt = require('bcryptjs'); 
const jwt = require('jsonwebtoken'); 
const { Pool } = require('pg');
const multer = require('multer'); 

const app = express();
const PORT = 3001;
const JWT_SECRET = process.env.JWT_SECRET;

// --- Database Connection ---
const pool = new Pool({
    // IMPORTANT: Replace this placeholder with your actual Internal Connection String from Render
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- Global In-Memory Storage & Middlewares ---
let allAssignments = {}; 
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// =============================================================
//               AUTHENTICATION ENDPOINTS
// =============================================================

// --- 1. Register a new caller (for setup) ---
app.post('/api/register', async (req, res) => {
    const { username, password, fullName } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username and password are required." });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);
        const newUser = await pool.query(
            "INSERT INTO callers (username, password_hash, full_name) VALUES ($1, $2, $3) RETURNING caller_id, username",
            [username, passwordHash, fullName]
        );
        res.status(201).json(newUser.rows[0]);
    } catch (err) {
        console.error(err.message);
        if (err.code === '23505') {
            return res.status(400).json({ message: "Username already exists." });
        }
        res.status(500).send("Server error during registration.");
    }
});

// --- 2. Login a caller ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const userResult = await pool.query("SELECT * FROM callers WHERE username = $1", [username]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ message: "Invalid username or password." });
        }
        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ message: "Invalid username or password." });
        }
        const payload = { user: { id: user.caller_id, username: user.username } };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
        res.json({ token, username: user.username });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error during login.");
    }
});

// --- 3. Authentication Middleware (to protect routes) ---
function authMiddleware(req, res, next) {
    const token = req.header('x-auth-token');
    if (!token) {
        return res.status(401).json({ message: "No token, authorization denied." });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded.user;
        next();
    } catch (err) {
        res.status(401).json({ message: "Token is not valid." });
    }
}

// --- 4. Secure Password Change Endpoint ---
app.post('/api/change-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const { id: callerId } = req.user; 
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "All fields are required." });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters long." });
    }
    try {
        const userResult = await pool.query("SELECT password_hash FROM callers WHERE caller_id = $1", [callerId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: "User not found." });
        }
        const storedHash = userResult.rows[0].password_hash;
        const isMatch = await bcrypt.compare(currentPassword, storedHash);
        if (!isMatch) {
            return res.status(400).json({ message: "Incorrect current password." });
        }
        const salt = await bcrypt.genSalt(10);
        const newPasswordHash = await bcrypt.hash(newPassword, salt);
        await pool.query("UPDATE callers SET password_hash = $1 WHERE caller_id = $2", [newPasswordHash, callerId]);
        res.json({ message: "Password updated successfully!" });
    } catch (err) {
        console.error("Password change error:", err.message);
        res.status(500).send("Server error during password change.");
    }
});

// =============================================================
//               API ENDPOINTS FOR CALLER APP
// =============================================================
app.get('/api/calls', authMiddleware, (req, res) => {
    const username = req.user.username;
    const userCalls = allAssignments[username] || []; 
    res.json(userCalls);
});

app.post('/api/feedback', authMiddleware, async (req, res) => {
    const feedback = req.body;
    const callerId = req.user.id;
    try {
        const query = `INSERT INTO feedback (call_id, passenger_name, phone_number, operator, route, punctuality, ac_working, live_tracking, staff_behavior_stars, bus_cleanliness_stars, rest_stop_hygiene_stars, comments, submitted_at, caller_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`;
        const values = [
            feedback.passengerId, feedback["Passenger Name"], feedback["Phone Number"], feedback["Operator"], feedback["Route"], feedback["Punctuality"],
            feedback["AC Working"], feedback["Live Tracking"], feedback["Staff Behavior (Stars)"], feedback["Bus Cleanliness (Stars)"],
            feedback["Rest Stop Hygiene (Stars)"], feedback["Comments"], feedback["Timestamp"], callerId
        ];
        await pool.query(query, values);
        res.status(201).json({ message: 'Feedback received and saved successfully!' });
    } catch (err) {
        res.status(500).json({ message: "Failed to save feedback." });
    }
});

// =============================================================
//            API ENDPOINTS FOR MANAGER DASHBOARD
// =============================================================
app.post('/api/upload-sheet', upload.single('callsheet'), (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file uploaded." });
    const filePath = req.file.path;
    try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = xlsx.utils.sheet_to_json(worksheet);
        const newAssignments = {};
        let callIdCounter = 1;
        for (const row of data) {
            const username = row.Caller;
            if (!username) continue;
            if (!newAssignments[username]) newAssignments[username] = [];
            newAssignments[username].push({
                id: callIdCounter++,
                passenger_name: row['Passenger Name'], phone_number: row['Phone'],
                operator: row['Service Name'], route: row['Route'],
                bus_no: row['Bus No.'], driver_name: row['Driver Name'],
                driver_phone: row['Driver Phone'], time: row['Time'],
                ticket_no: row['Ticket No'], seat_no: row['Seat No'],
                status: "Pending"
            });
        }
        allAssignments = newAssignments;
        fs.unlinkSync(filePath);
        res.json({ message: `Sheet processed. Loaded assignments for ${Object.keys(allAssignments).length} callers.` });
    } catch (error) {
        fs.unlinkSync(filePath);
        res.status(500).json({ message: "Error processing Excel file." });
    }
});

// Provides the real-time performance summary for the dashboard.
app.get('/api/performance-summary', (req, res) => {
    const callerData = Object.keys(allAssignments).map((username, index) => {
        const calls = allAssignments[username];
        const totalAssigned = calls.length;
        const callsDone = calls.filter(call => call.status === 'Complete').length;
        const operators = [...new Set(calls.map(call => call.operator))];

        return {
            caller_id: 101 + index,
            caller_name: username,
            avatar: `https://i.pravatar.cc/150?u=${username}`,
            total_calls_assigned: totalAssigned,
            calls_done: callsDone,
            operators_assigned: operators.join(', ')
        };
    });
    
    res.json({
        callers: callerData,
        operators: [] // Operator data is deferred as requested
    });
});

// --- START THE SERVER ---
app.listen(PORT, () => {
    console.log(`✅ Server is listening on http://localhost:${PORT}`);
});