/** Sage camera bridge. See README.md for bounded media, authentication, and deployment. */

import express from "express";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { CameraMedia, connectionDiagnostics } from "./media.js";
import { transcode } from "./transcode.js";
import { whatsappVideo } from "./whatsapp-video.js";
import { SpeechLedger } from "./speech-ledger.js";
import { installCellularRelay } from "./cellular-relay.js";
if (["true", "experimental"].includes(process.env.EUFY_CELLULAR_RELAY)) installCellularRelay();
import { fileURLToPath } from "node:url";
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.env.BRIDGE_PORT || 8090;
if (!process.env.BRIDGE_AUTH_TOKEN) throw new Error("BRIDGE_AUTH_TOKEN must be configured");
const diagnostics = connectionDiagnostics();
const sessionPath = process.env.EUFY_SESSION_PATH || path.join(__dirname, ".eufy-session.json");
mkdirSync(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
const speechLedger = new SpeechLedger(path.join(path.dirname(sessionPath), "speech-receipts"));
const media = new CameraMedia(async () => {
  if (!ready) throw Object.assign(new Error("Camera login is not ready"), { status: 503 });
  if (!process.env.EUFY_CAMERA_SN) throw Object.assign(new Error("EUFY_CAMERA_SN is not configured"), { status: 503 });
  const dev = await eufy.getDevice(process.env.EUFY_CAMERA_SN);
  const cam = dev.camera?.();
  if (!cam) throw Object.assign(new Error("Device has no camera API"), { status: 501 });
  return cam;
});
function tokenMatches(value) {
  const actual = Buffer.from(typeof value === "string" ? value : "");
  const expected = Buffer.from(process.env.BRIDGE_AUTH_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

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
    store: new FileSessionStore(sessionPath),
    logger: diagnostics.logger,
    noBroadcast: true,
    p2pIdleMs: 15000,
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  });

  eufy.on("error", error => diagnostics.logger.error(error.message));
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
app.disable("x-powered-by");
app.use((req, res, next) => { res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer"); next(); });
app.use(express.urlencoded({ extended: false, limit: "8kb" }));

// Bearer-token auth for the real API — but NOT for /verify, which a human
// opens directly in a browser and authenticates via ?token= instead.
app.use((req, res, next) => {
  if (req.path === "/verify") return next();
  if (!req.headers.authorization?.startsWith("Bearer ") || !tokenMatches(req.headers.authorization.slice(7))) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

function checkVerifyToken(req, res) {
  if (!tokenMatches(req.query.token)) {
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
  res.json({ ready, lastLiveFrameAt: media.lastLiveFrameAt || null, lastLiveImageAt: media.lastLiveImageAt || null, busy: media.busy, pending: pendingChallenge?.kind ?? null, connection: diagnostics.snapshot() });
});

app.get("/devices", async (req, res) => {
  if (!ready) return res.status(503).json({ error: "not logged in yet" });
  try {
    const devices = await eufy.getDevices();
    res.json(devices.map((d) => ({ sn: d.sn, name: d.name })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Reading cached power facts does not start a camera stream. Charging alone
// does not establish continuous mains power (solar also charges this model).
app.get("/power-status", async (req, res) => {
  try {
    if (!ready) return res.status(503).json({ error: "not logged in yet" });
    const dev = await eufy.getDevice(process.env.EUFY_CAMERA_SN);
    const battery = dev.battery?.();
    res.json({ checkedAt: new Date().toISOString(), battery: battery?.level ?? null,
      charging: battery?.charging ?? null, configuredSource: battery?.powerSource ?? null,
      solarIntensity: battery?.solarIntensity ?? null, solarConnected24h: battery?.solarConnected24h ?? null,
      continuousPowerConfirmed: false, policy: "five-minute-checks",
      note: "Cached device facts. Charging does not prove continuous mains power on this battery camera." });
  } catch (e) { res.status(502).json({ error: "Power status unavailable" }); }
});

app.get("/audio-status", async (req, res) => {
  try {
    if (!ready) return res.status(503).json({ error: "not logged in yet" });
    const dev = await eufy.getDevice(process.env.EUFY_CAMERA_SN);
    const audio = dev.audio?.();
    res.json({ speaker: audio?.speaker ?? null, volume: audio?.volume ?? null,
      microphone: audio?.microphone ?? null, audioRecording: audio?.audioRecording ?? null });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Authenticated diagnostics never expose raw P2P records or credentials.
app.get("/debug", async (req, res) => {
  try {
    if (!ready) return res.status(503).json({ error: "not logged in yet" });
    const dev = await eufy.getDevice(process.env.EUFY_CAMERA_SN);
    const cam = dev.camera?.();
    const out = { checkedAt: new Date().toISOString(), capabilities: dev.capabilities,
      battery: dev.battery?.()?.level ?? null,
      methods: Object.fromEntries(["snapshotLive", "snapshotStored", "live", "recordFragments", "talkback"].map(k => [k, typeof cam?.[k] === "function"])) };
    for (const mode of ["live", "stored"]) {
      try { const shot = await media.snapshot(mode); out[mode] = { ok: true, bytes: shot.jpeg.length, source: shot.source }; }
      catch (e) { out[mode] = { ok: false, error: e.message, reason: e.reason }; }
    }
    out.connection = diagnostics.snapshot();
    res.json(out);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/snapshot", async (req, res) => {
  try {
    const shot = await media.snapshot(req.query.mode || "live");
    res.set("X-Snapshot-Source", shot.source);
    res.set("X-Retrieved-At", shot.retrievedAt);
    if (shot.capturedAt) res.set("X-Captured-At", shot.capturedAt);
    res.type("image/jpeg").send(shot.jpeg);
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/observe", async (req, res) => {
  try {
    const { jpeg, ...evidence } = await media.snapshot("live");
    res.json({ ...evidence, image: { mime: "image/jpeg", base64: jpeg.toString("base64") } });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

// Bounded MP4 containing video and camera audio when the device delivers it.
app.get("/clip", async (req, res) => {
  try {
    const clip = await media.clip(Number(req.query.seconds || 10));
    res.type("video/mp4").send(req.query.format === "whatsapp" ? await whatsappVideo(clip) : clip);
  }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.get("/listen", async (req, res) => {
  try {
    const clip = await media.clip(Number(req.query.seconds || 5));
    const wav = await transcode(clip, "mp4", "wav");
    res.json({ retrievedAt: new Date().toISOString(), audio: { mime: "audio/wav", base64: wav.toString("base64") } });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

app.post("/speak", express.raw({ type: ["audio/aac", "audio/aacp", "audio/ogg", "audio/wav", "audio/mpeg"], limit: "2mb" }), async (req, res) => {
  if (process.env.EUFY_TALK_ENABLED !== "true") return res.status(503).json({ error: "Talkback is not enabled on this bridge" });
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Audio body is required" });
    const result = await speechLedger.run(req.headers["idempotency-key"], req.body, async () => {
      const format = { "audio/ogg": "ogg", "audio/wav": "wav", "audio/mpeg": "mp3" }[req.get("Content-Type")?.split(";")[0]];
      const aac = format ? await transcode(req.body, format, "adts") : req.body;
      return media.speak(aac);
    });
    res.json(result);
  } catch (e) {
    const code = e.code === 'camera_not_ready' ? 'camera_not_ready' : undefined;
    console.log('[speech] request failed: ' + (code || 'unconfirmed') + ' status=' + (e.status || 502));
    res.status(e.status || 502).json({ error: e.message, code });
  }
});

// Server starts immediately regardless of login state, so a login problem
// never crashes the process — Railway restarts crashed processes instantly,
// and repeated instant retries is exactly what tripped eufy's
// 5-failed-attempts lockout earlier. Failed/blocked logins just wait.
app.listen(PORT, process.env.BRIDGE_HOST || "0.0.0.0", () => console.log(`[eufy-bridge] listening on :${PORT}`));

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
