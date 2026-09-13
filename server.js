/**
 * eufy-bridge — small Node service that sits between Sage's brain (Python, in
 * sage-whatsapp) and the eufy cloud (Node-only SDK, no Python equivalent).
 *
 * Sage's tool loop calls GET /snapshot to get a fresh JPEG "as needed" — no
 * polling, no fixed cadence. The eufy session (login/2FA) happens ONCE at
 * boot and is cached to disk, so this service stays logged in across restarts
 * without asking for a 2FA code again.
 *
 * Env vars (already set on this Railway service — never re-typed here):
 *   EUFY_EMAIL, EUFY_PASSWORD, EUFY_COUNTRY
 *   EUFY_CAMERA_SN     — the S330's serial number (fill in after first boot;
 *                        boot log prints every device + serial so you can copy it)
 *   BRIDGE_PORT        — defaults to 8090
 *   BRIDGE_AUTH_TOKEN  — shared secret Sage's tool sends as `Authorization: Bearer <token>`
 *                        so this endpoint isn't open to anyone who finds the URL
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BRIDGE_PORT || 8090;

let eufy;
let ready = false;

async function boot() {
  if (!process.env.EUFY_EMAIL || !process.env.EUFY_PASSWORD) {
    throw new Error("EUFY_EMAIL / EUFY_PASSWORD not set on this service.");
  }

  eufy = new EufyMega({
    email: process.env.EUFY_EMAIL,
    password: process.env.EUFY_PASSWORD,
    countryCode: process.env.EUFY_COUNTRY || "US",
    // Persisted on Railway's volume so a redeploy doesn't force a fresh 2FA.
    store: new FileSessionStore(path.join(__dirname, ".eufy-session.json")),
  });

  let r = await eufy.login();
  while (r.status !== LoginStatus.Ok) {
    if (r.status === LoginStatus.TwoFactor) {
      // First boot only: check Railway deploy logs for this line, get the
      // code from email/SMS, then set EUFY_2FA as a one-time variable and
      // redeploy. Remove EUFY_2FA once login succeeds — it's single-use.
      if (!process.env.EUFY_2FA) {
        throw new Error(`2FA code required (sent via ${r.method ?? "account default"}) — set EUFY_2FA and redeploy.`);
      }
      r = await eufy.submitVerifyCode(process.env.EUFY_2FA);
    } else if (r.status === LoginStatus.Captcha) {
      throw new Error("eufy is asking for a captcha — this needs a manual run to clear, see feasibility test.");
    } else {
      throw new Error(`Unexpected login status: ${JSON.stringify(r)}`);
    }
  }

  console.log("[eufy-bridge] logged in. Devices on this account:");
  const devices = await eufy.getDevices();
  for (const d of devices) {
    console.log(`  sn=${d.sn}  name="${d.name}"`);
  }

  ready = true;
  console.log(`[eufy-bridge] ready — target camera sn=${process.env.EUFY_CAMERA_SN || "(not set yet — see log above)"}`);
}

const app = express();

app.use((req, res, next) => {
  const want = process.env.BRIDGE_AUTH_TOKEN;
  if (want && req.headers.authorization !== `Bearer ${want}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (req, res) => {
  res.json({ ready });
});

app.get("/devices", async (req, res) => {
  if (!ready) return res.status(503).json({ error: "not logged in yet" });
  const devices = await eufy.getDevices();
  res.json(devices.map((d) => ({ sn: d.sn, name: d.name })));
});

// The one endpoint Sage's tool actually calls.
app.get("/snapshot", async (req, res) => {
  if (!ready) return res.status(503).json({ error: "not logged in yet" });
  const sn = req.query.sn || process.env.EUFY_CAMERA_SN;
  if (!sn) return res.status(400).json({ error: "no camera serial configured (EUFY_CAMERA_SN or ?sn=)" });

  try {
    const dev = await eufy.getDevice(sn);
    const cam = dev.camera?.();
    if (!cam) return res.status(404).json({ error: `${sn} has no camera capability` });

    const jpeg = await cam.snapshotLive?.();
    if (!jpeg) return res.status(502).json({ error: "snapshotLive() returned nothing" });

    res.set("Content-Type", "image/jpeg");
    res.send(Buffer.from(jpeg));
  } catch (e) {
    console.error("[eufy-bridge] snapshot error:", e);
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Start the HTTP server immediately regardless of login outcome, so a login
// failure doesn't crash the process — Railway restarts crashed processes
// instantly, and repeated instant retries is exactly what tripped eufy's
// 5-failed-attempts lockout last time. Failed logins now just log and wait.
app.listen(PORT, () => console.log(`[eufy-bridge] listening on :${PORT}`));

const RETRY_MS = 10 * 60 * 1000; // back off 10 min between login retries

async function bootLoop() {
  try {
    await boot();
  } catch (e) {
    console.error("[eufy-bridge] login attempt failed:", e instanceof Error ? e.message : e);
    console.error(`[eufy-bridge] will retry in ${RETRY_MS / 60000} minutes (not crash-looping).`);
    setTimeout(bootLoop, RETRY_MS);
  }
}

bootLoop();
