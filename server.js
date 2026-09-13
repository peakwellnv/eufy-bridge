/**
 * eufy-bridge — small Node service that sits between Sage's brain (Python, in
 * sage-whatsapp) and the eufy cloud (Node-only SDK, no Python equivalent).
 *
 * Sage's tool loop calls GET /snapshot to get a fresh JPEG "as needed" — no
 * polling, no fixed cadence. The eufy session (login/2FA/captcha) happens
 * ONCE and is cached to disk, so this service stays logged in across
 * restarts without asking again — UNTIL Railway redeploys onto a fresh
 * filesystem, since there's no persistent volume attached yet.
 *
 * FIRST-TIME LOGIN (captcha/2FA): open
 *   https://<this-service's-public-domain>/verify?token=<BRIDGE_AUTH_TOKEN>
 * in a browser. If eufy needs a captcha or a 2FA code, you'll see a small
 * form right there — no Railway variables, no redeploy needed to clear it.
 *
 * Env vars:
 *   EUFY_EMAIL, EUFY_PASSWORD, EUFY_COUNTRY
 *   EUFY_CAMERA_SN     — the S330's serial number (fill in after first boot;
 *                        boot log prints every device + serial so you can copy it)
 *   BRIDGE_PORT        — defaults to 8090
 *   BRIDGE_AUTH_TOKEN  — shared secret. Sage's tool sends it as
 *                        `Authorization: Bearer <token>`; the /verify page
 *                        takes it as ?token=<token> since it's opened by hand.
 */

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BRIDGE_PORT || 8090;

let eufy;
let ready = false;

// Holds whatever eufy challenge (captcha or 2FA) is currently blocking login,
// plus the function that unblocks boot()'s await once a human answers it.
let pendingChallenge = null; // { kind: "captcha"|"2fa", image?: string, method?: string, resolve: (answer) => void }

function waitForChallenge(kind, extra) {
  return new Promise((resolve) => {
    pendingChallenge = { kind, ...extra, resolve };
    console.log(`[eufy-bridge] waiting on ${kind} — open /verify?token=<BRIDGE_AUTH_TOKEN> in a browser to clear it.`);
  });
}

async function boot() {
  if (!process.env.EUFY_EMAIL || !process.env.EUFY_PASSWORD) {
    throw new Error("EUFY_EMAIL / EUFY_PASSWORD not set on this service.");
  }

  eufy = new EufyMega({
    email: process.env.EUFY_EMAIL,
    password: process.env.EUFY_PASSWORD,
    countryCode: process.env.EUFY_COUNTRY || "US",
    store: new FileSessionStore(path.join(__dirname, ".eufy-session.json")),
  });

  let r = await eufy.login();
  while (r.status !== LoginStatus.Ok) {
    if (r.status === LoginStatus.Captcha) {
      const answer = await waitForChallenge("captcha", { image: r.image });
      r = await eufy.solveCaptcha(answer);
    } else if (r.status === LoginStatus.TwoFactor) {
      const answer = await waitForChallenge("2fa", { method: r.method });
      r = await eufy.submitVerifyCode(answer);
    } else {
      throw new Error(`Unexpected login status: ${JSON.stringify(r)}`);
    }
  }

  pendingChallenge = null;
  console.log("[eufy-bridge] logged in. Devices on this account:");
  const devices = await eufy.getDevices();
  for (const d of devices) {
    console.log(`  sn=${d.sn}  name="${d.name}"`);
  }

  ready = true;
  console.log(`[eufy-bridge] ready — target camera sn=${process.env.EUFY_CAMERA_SN || "(not set yet — see log above)"}`);
}

const app = express();
app.use(express.urlencoded({ extended: false }));

// Bearer-token auth for the real API — but NOT for /verify, which a human
// opens directly in a browser and authenticates via ?token= instead.
app.use((req, res, next) => {
  if (req.path === "/verify") return next();
  const want = process.env.BRIDGE_AUTH_TOKEN;
  if (want && req.headers.authorization !== `Bearer ${want}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

function checkVerifyToken(req, res) {
  const want = process.env.BRIDGE_AUTH_TOKEN;
  if (want && req.query.token !== want) {
    res.status(401).send("Missing or wrong ?token=");
    return false;
  }
  return true;
}

app.get("/verify", (req, res) => {
  if (!checkVerifyToken(req, res)) return;

  if (ready) return res.send("<p>Already logged in — nothing to verify.</p>");
  if (!pendingChallenge) return res.send("<p>No challenge pending right now. Refresh in a minute — a login attempt may be about to start.</p>");

  const token = encodeURIComponent(req.query.token || "");
  if (pendingChallenge.kind === "captcha") {
    res.send(`
      <h3>eufy captcha</h3>
      <img src="${pendingChallenge.image}" alt="captcha" />
      <form method="POST" action="/verify?token=${token}">
        <input name="answer" autofocus placeholder="type what you see" />
        <button type="submit">Submit</button>
      </form>
    `);
  } else {
    res.send(`
      <h3>eufy 2FA code</h3>
      <p>A code was sent via ${pendingChallenge.method ?? "your account's usual method"}.</p>
      <form method="POST" action="/verify?token=${token}">
        <input name="answer" autofocus placeholder="6-digit code" />
        <button type="submit">Submit</button>
      </form>
    `);
  }
});

app.post("/verify", (req, res) => {
  if (!checkVerifyToken(req, res)) return;
  if (!pendingChallenge) return res.status(409).send("Nothing pending.");

  const answer = (req.body.answer || "").trim();
  const resolve = pendingChallenge.resolve;
  pendingChallenge = null; // clear before resolve so a slow client can't double-submit
  resolve(answer);
  res.send("<p>Submitted. Check the deploy logs for the result — refresh /verify if another step is needed.</p>");
});

app.get("/health", (req, res) => {
  res.json({ ready, pending: pendingChallenge?.kind ?? null });
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

// Server starts immediately regardless of login state, so a login problem
// never crashes the process — Railway restarts crashed processes instantly,
// and repeated instant retries is exactly what tripped eufy's
// 5-failed-attempts lockout earlier. Failed/blocked logins just wait.
app.listen(PORT, () => console.log(`[eufy-bridge] listening on :${PORT}`));

const RETRY_MS = 10 * 60 * 1000; // back off 10 min between login retries after a hard failure

async function bootLoop() {
  try {
    await boot();
  } catch (e) {
    pendingChallenge = null;
    console.error("[eufy-bridge] login attempt failed:", e instanceof Error ? e.message : e);
    console.error(`[eufy-bridge] will retry in ${RETRY_MS / 60000} minutes (not crash-looping).`);
    setTimeout(bootLoop, RETRY_MS);
  }
}

bootLoop();
