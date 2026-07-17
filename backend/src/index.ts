import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import papersRoutes from "./routes/papers.js";
import lookupsRoutes from "./routes/lookups.js";
import feedbackRoutes from "./routes/feedback.js";
import uploadRoutes from "./routes/upload.js";
import extractRoutes from "./routes/extract.js";
import importRoutes from "./routes/import.js";

import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);

// Trust proxy for Render reverse proxy (required for correct rate limiting IP detection)
app.set("trust proxy", 1);

// ── Security Headers ──
app.use(helmet());

// ── Rate Limiting ──
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15, // limit each IP to 15 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, please try again later." },
});

export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30, // limit each IP to 30 files per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload/extraction attempts, please try again later." },
});

export const feedbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many feedback submissions, please try again later." },
});

app.use("/api/", generalLimiter);

// ── CORS Whitelisting ──
const whitelist = [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://rcpit-pyq-paper.onrender.com",
  "https://rcpit-pyq-paper-l8zj.onrender.com",
];
if (process.env.CORS_ORIGIN) {
  whitelist.push(process.env.CORS_ORIGIN.replace(/\/$/, ""));
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const cleanOrigin = origin.replace(/\/$/, "");
      if (whitelist.includes(cleanOrigin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "25mb" })); // Limit payload size to protect against large body DoS
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ── Routes ──
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/papers", papersRoutes);
app.use("/api/lookups", lookupsRoutes);
app.use("/api/feedback", feedbackLimiter, feedbackRoutes);
app.use("/api/upload", uploadLimiter, uploadRoutes);
app.use("/api/extract", uploadLimiter, extractRoutes);
app.use("/api/import", importRoutes);

// ── Health check ──
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── 404 handler ──
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Error handler ──
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

// ── Start server ──
app.listen(PORT, () => {
  console.log(`🚀 Paper Finder API running on http://localhost:${PORT}`);
  console.log(`   CORS whitelist: ${whitelist.join(", ")}`);
  console.log(`   Routes:`);
  console.log(`     /api/auth     — Authentication`);
  console.log(`     /api/papers   — Paper CRUD`);
  console.log(`     /api/lookups  — Lookup tables`);
  console.log(`     /api/feedback — Feedback`);
  console.log(`     /api/upload   — File uploads`);
  console.log(`     /api/extract  — AI extraction`);
  console.log(`     /api/import   — Bulk import`);
  console.log(`     /api/health   — Health check`);
});

export default app;
