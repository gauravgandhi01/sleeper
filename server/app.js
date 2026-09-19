import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { History } from "./history.js";
import { linkCurrentOwners } from "./identities.js";
import { applyDisplayNames } from "./names.js";
import { leagueRecords, headToHead } from "./records.js";
import { OWNER_ICONS } from "../src/owner-icons.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export async function createApp({ service, publicBaseUrl = "http://localhost:4174", history = null, currentSeason = process.env.CURRENT_SEASON || "2026" }) {
  history ||= await History.load();
  const origin = new URL(publicBaseUrl).origin;
  if (!["http:", "https:"].includes(new URL(origin).protocol)) throw new Error("PUBLIC_BASE_URL must be HTTP(S)");
  const html = (await readFile(join(root, "index.html"), "utf8")).replaceAll("__PUBLIC_BASE_URL__", escapeHtml(origin));
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(["/api", "/healthz"], (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const sendDashboard = async (req, res) => {
    const year = req.query.season;
    if (req.method === "GET" && year !== undefined && year !== String(service.saved?.snapshot.metadata.season || currentSeason)) {
      const historical = typeof year === "string" && /^\d{4}$/.test(year) ? history.dashboard(year) : null;
      if (!historical) return res.status(404).json({ error: "Season not found. Choose an available season." });
      return res.json(historical);
    }
    if (req.method === "POST" || !service.saved) await service.refresh();
    const value = service.dashboard();
    if (!value) return res.status(503).json({ error: "League data is temporarily unavailable. Please try again shortly." });
    res.json({ ...value, source: "sleeper" });
  };
  app.get("/api/seasons", (req, res) => res.json(history.seasons(service.saved?.snapshot.metadata.season || currentSeason)));
  app.get("/api/owners", (req, res) => {
    const era = req.query.era ?? "all";
    if (!["all", "ten-team"].includes(era)) return res.status(400).json({ error: "Era must be all or ten-team." });
    res.json(history.careers(service.saved ? linkCurrentOwners(applyDisplayNames(service.saved.snapshot)) : null, { era, currentSeason: service.saved?.snapshot.metadata.season || currentSeason, stale: service.dashboard()?.stale ?? true }));
  });
  app.get("/api/dashboard", sendDashboard);
  for (const [path, calculate] of [["/api/records", leagueRecords], ["/api/head-to-head", headToHead]]) {
    app.get(path, (req, res) => {
      const era = req.query.era ?? "ten-team";
      if (!["all", "ten-team"].includes(era)) return res.status(400).json({ error: "Era must be all or ten-team." });
      const snapshot = service.saved ? linkCurrentOwners(applyDisplayNames(service.saved.snapshot)) : null;
      try {
        res.json(calculate(history.archive, snapshot, { era, stage: req.query.stage, ownerA: req.query.ownerA, ownerB: req.query.ownerB, currentSeason: snapshot?.metadata.season || currentSeason, stale: service.dashboard()?.stale ?? true }));
      } catch (error) {
        if (["Choose a known owner.", "Choose two different owners.", "Stage must be all, regular or playoff."].includes(error.message)) return res.status(400).json({ error: error.message });
        throw error;
      }
    });
  }
  app.post("/api/refresh", sendDashboard);
  app.get("/healthz", async (req, res) => {
    try {
      await service.store.health();
      res.json({ status: "ok", storage: "ok", dataAvailable: Boolean(service.saved), lastSuccessfulFetchAt: service.saved?.lastSuccessfulFetchAt || null, stale: service.dashboard()?.stale ?? true });
    } catch { res.status(503).json({ status: "unhealthy", storage: "unavailable", dataAvailable: Boolean(service.saved) }); }
  });
  app.get("/", (req, res) => { res.set("Cache-Control", "no-cache").type("html").send(html); });
  for (const asset of ["styles.css", "src/app.js", "src/ui.js", "src/owner-icons.js", "src/theme.js", "logo.png", "logo_white.png", "public/favicon.svg", "public/og.png", ...Object.values(OWNER_ICONS)]) {
    app.get(`/${asset}`, (req, res) => res.sendFile(join(root, asset), { maxAge: 0 }));
  }
  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error, req, res, next) => {
    console.error("request_failure", error.message);
    if (res.headersSent) return next(error);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });
  return app;
}
