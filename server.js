import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import dotenv from 'dotenv';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { Server } from 'socket.io';

// Import routes
import productRoutes from './routes/productRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import bannerRoutes from './routes/bannerRoutes.js';
import apkRoutes from './routes/apkRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import settingsRoutes from './routes/settingRoutes.js';

// Import database config
import connectDB from './config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);

/* ======================================================
   SOCKET.IO SETUP
   ====================================================== */
export const io = new Server(httpServer, {
    cors: {
        origin: [
            process.env.FRONTEND_URL,
            process.env.ADMIN_FRONTEND_URL,
            'http://localhost:5173',
            'http://localhost:5174',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:5174'
        ].filter(Boolean),
        methods: ['GET', 'POST'],
        credentials: true
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // Admin panel joins admin room
    socket.on('admin_join', () => {
        socket.join('admin_room');
        console.log(`👨‍💼 Admin joined admin_room: ${socket.id}`);
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
});

/* ======================================================
   TRUST PROXY
   ====================================================== */
app.set('trust proxy', 1);

/* ======================================================
   DATABASE
   ====================================================== */
connectDB().catch(err => {
    console.error('❌ MongoDB connection failed:', err);
});

/* ======================================================
   SECURITY & PERFORMANCE
   ====================================================== */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());

if (process.env.NODE_ENV === 'production') {
    app.use(morgan('combined'));
} else {
    app.use(morgan('dev'));
}

/* ======================================================
   CORS
   ====================================================== */
const corsOptions = {
    origin: function (origin, callback) {
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400,
    optionsSuccessStatus: 204
};

app.use(cors(corsOptions));

/* ======================================================
   BODY PARSER
   ====================================================== */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ======================================================
   RATE LIMITING
   ====================================================== */
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: process.env.NODE_ENV === 'production' ? 300 : 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const skipPaths = ['/health', '/api/apk-status', '/api/settings', '/api/settings/merchant-upi'];
        return skipPaths.some(p => req.path.startsWith(p));
    },
    handler: (req, res) => {
        console.warn(`⚠️ Rate limit hit | IP: ${req.ip} | Path: ${req.path}`);
        res.status(429).json({ success: false, error: 'Too many requests. Please try again in 1 minute.', retryAfter: 60 });
    }
});

app.use('/api', limiter);

/* ======================================================
   STATIC FILES
   ====================================================== */
app.use('/public', express.static(path.join(__dirname, 'public')));

/* ======================================================
   APK ROUTES
   ====================================================== */
app.get('/api/download/apk', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'dmart-app.apk');
    if (!fs.existsSync(apkPath)) {
        return res.status(404).json({ success: false, error: 'APK not found' });
    }
    res.download(apkPath, 'DMart-App.apk');
});

app.get('/api/apk-status', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'downloads', 'dmart-app.apk');
    res.json({ success: true, available: fs.existsSync(apkPath) });
});

/* ======================================================
   HEALTH CHECK
   ====================================================== */
app.get('/health', (req, res) => {
    res.json({ success: true, uptime: process.uptime(), environment: process.env.NODE_ENV || 'development' });
});

/* ======================================================
   API ROUTES
   ====================================================== */
app.use('/api/products', productRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/order', orderRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/apk', apkRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/settings', settingsRoutes);

/* ======================================================
   404 HANDLER
   ====================================================== */
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, message: 'API endpoint not found' });
});

/* ======================================================
   GLOBAL ERROR HANDLER
   ====================================================== */
app.use((err, req, res, next) => {
    console.error('❌ Global Error:', err);
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, message: err.message });
    }
    res.status(err.status || 500).json({ success: false, message: err.message || 'Internal server error' });
});

/* ======================================================
   SERVER START
   ====================================================== */
const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔌 Socket.io enabled`);
    console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
    console.log(`🔧 Admin Frontend URL: ${process.env.ADMIN_FRONTEND_URL || 'http://localhost:5174'}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

httpServer.timeout = 0;
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 66000;

const shutdown = (signal) => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;