import "dotenv/config";
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth.js";
import papersRoutes from "./routes/papers.js";
import lookupsRoutes from "./routes/lookups.js";
import feedbackRoutes from "./routes/feedback.js";
import uploadRoutes from "./routes/upload.js";
import extractRoutes from "./routes/extract.js";

const app = express();
const PORT = parseInt(process.env.PORT || "5000", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

// ── Middleware ──
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "25mb" })); // Large limit for base64 PDF uploads
app.use(express.urlencoded({ extended: true }));

// ── Routes ──
app.use("/api/auth", authRoutes);
app.use("/api/papers", papersRoutes);
app.use("/api/lookups", lookupsRoutes);
app.use("/api/feedback", feedbackRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/extract", extractRoutes);

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
  console.log(`   CORS origin: ${CORS_ORIGIN}`);
  console.log(`   Routes:`);
  console.log(`     /api/auth     — Authentication`);
  console.log(`     /api/papers   — Paper CRUD`);
  console.log(`     /api/lookups  — Lookup tables`);
  console.log(`     /api/feedback — Feedback`);
  console.log(`     /api/upload   — File uploads`);
  console.log(`     /api/extract  — AI extraction`);
  console.log(`     /api/health   — Health check`);
});

export default app;
