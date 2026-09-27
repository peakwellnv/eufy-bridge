# Sage eufy T86P2 bridge

Working P2P camera transport without RTSP. Verified on the T86P2 on September 13, 2026: fresh JPEGs across idle reconnects, MP4 containing video and microphone audio, and spoken audio confirmed by the owner at the camera.

## Run and deploy

Node 24.5+ and ffmpeg are required; the Dockerfile includes both. Run `npm ci`, `npm test`, then `npm start`.

Configure `EUFY_EMAIL`, `EUFY_PASSWORD`, `EUFY_COUNTRY`, `EUFY_CAMERA_SN`, and a strong `BRIDGE_AUTH_TOKEN` through the deployment secret manager. Set `EUFY_CELLULAR_RELAY=true` and `EUFY_TALK_ENABLED=true` for this camera. Use one replica. Mount a persistent volume at `/data` and set `EUFY_SESSION_PATH=/data/eufy-session.json`; both cached login and speech receipts survive deployment. `FFMPEG_PATH` optionally overrides ffmpeg.

Complete any CAPTCHA or 2FA at `/verify?token=<BRIDGE_AUTH_TOKEN>`. Keep that URL private. Every other endpoint requires `Authorization: Bearer <token>`. Missing token prevents startup. Responses disable caching.

## API

| Endpoint | Result |
| --- | --- |
| `GET /health` | Login/challenge, busy state, last fresh image, nonsecret connection counters. Login alone does not prove media. |
| `GET /audio-status` | Read-only speaker switch, volume and microphone state. |
| `GET /debug` | Bounded live/stored checks and battery; wakes the camera. |
| `GET /snapshot?mode=live` | Fresh JPEG (default); retained-only images fail. `stored` and explicit `auto` report their actual source. |
| `GET /observe` | Fresh JPEG base64, SHA-256 and capture/retrieval timestamps. |
| `GET /clip?seconds=10` | Fragmented MP4, video and microphone audio when supplied. 2–20 requested seconds after startup; keyframes may extend output duration. |
| `GET /listen?seconds=5` | Short microphone sample as base64 WAV. |
| `POST /speak` | AAC, MP3, OGG or WAV bytes with matching audio Content-Type and unique `Idempotency-Key`. |

Speech accepts at most 2 MB encoded input and 30 seconds of AAC-LC, mono, 16 kHz after conversion. AAC frame size is limited to the device's 640 bytes. The converter uses 16 kbps; invalid/oversized frames fail before waking the speaker. A fresh frame warms the live connection before talkback. Finite audio is paced at playback speed.

`transmitted` means audio reached the transport; each response still marks audibility unconfirmed because the bridge has no independent speaker feedback. Persistent receipts prevent repeated transmission after retry or restart. Never automatically retry uncertain speech with a new key. No audio is stored in receipts.

Media operations are exclusive (409 on overlap), bounded, and stop automatically. Idle connections detach after 15 seconds. This is sampled coverage; battery, cellular connectivity and data allowance affect availability.

## Why the relay adapter is needed

SDK 0.1.2's direct handshake drops the nonce in the cellular relay response. `cellular-relay.js` adds the nonce-bearing CHECK_CAM2 exchange, ongoing cellular lookup, and relay confirmation. Repeated offers must not restart relay initialization: deduplication is required for a successful connection. It is confined to T86P2 serials and pinned SDK internals. Review compatibility before upgrading the SDK.

Handshake structures derive from the MIT-licensed client at commit `3bfef130bdcbff8f2f68286a5f63ec7e48177202`; see THIRD_PARTY_NOTICES.txt. Real-camera tests verified this adapter; it changes no firmware or camera settings. A separate SDK return-shape fix unwraps `{jpeg,width,height}` correctly and respects retained-image flags.

## Sage companion

`sage-whatsapp/sage_booth.py` provides fresh observation, microphone transcription, history, speech, and five-minute monitoring. It uses Sage's existing providers. Only text descriptions, source timestamps and image hashes enter existing `agent_notes`; raw images/audio are not persisted there. The newest 1,000 observations are retained. Failures never become “empty booth” conclusions. Scene text and speech are untrusted content; no facial identity, emotional inference, or personnel evaluation is derived from images.

Owner tools: `observe_booth`, `listen_booth`, `booth_report`. `propose_booth_announcement` requires owner confirmation of exact text. Explicit owner command `sage booth say <text>` uses the existing action ledger and transport receipt protection. Sage's pause switch blocks new observations and speech.

Set `SAGE_BOOTH_ENABLED=true`, `SAGE_BOOTH_TALK_ENABLED=true`, `EUFY_BRIDGE_URL`, and `EUFY_BRIDGE_TOKEN`. Configure `SAGE_BOOTH_TIMEZONE=America/Denver` and `SAGE_BOOTH_HOURS` as JSON windows with weekday numbers (Monday=0), `start`, `end`, and explicit ISO `dates`. Empty hours perform no monitoring. Five-minute claims in existing `flags` prevent duplicate checks across processes/restarts. Failed checks retry at the next slot, not in a wakeup loop.

Utah State Fair 2026 public hours: September 10–20; weekdays noon–10pm, Friday/Saturday 10am–11pm, Sunday 10am–10pm. Source: https://www.utahstatefair.com/p/thefair/plan-your-visit/faqs . Explicit event dates stop checks after September 20. Update configuration when moving events.

Speech uses existing OpenAI TTS when configured, otherwise OpenRouter `/api/v1/audio/speech`, default model `hexgrad/kokoro-82m`, voice `af_heart` (configurable through `SAGE_BOOTH_TTS_MODEL`/`SAGE_BOOTH_TTS_VOICE`).

For speech, the bridge makes at most two attempts within a shared 60-second wakeup budget (at most 45 seconds per attempt) to obtain a fresh frame before opening talkback. This retries only camera wakeup, never audio transmission. If both attempts fail, `/speak` returns HTTP 503 with `code: camera_not_ready`, explicitly meaning no speech started. Other uncertain transport failures must not be automatically replayed.


## Wake recovery and faster speech

Fresh snapshots and speech readiness allow two pre-transmission wake attempts
within one 60-second budget. Speech now holds a live consumer and waits past its
possible cached keyframe, avoiding JPEG decoding just to start talkback. Audio
transmission itself is never retried automatically. Successful speech returns
wake and total milliseconds, and still reports audibility as unconfirmed.

Authenticated `/power-status` exposes only cached battery/charging/solar facts.
This T86P2 API cannot establish continuous mains power: charging can mean solar.
Until continuous power can be independently verified, retain five-minute checks
and the SDK battery budget; do not keep a continuous video stream alive.

`GET /clip?seconds=10&format=whatsapp` converts camera HEVC fragments to a
seekable H.264/AAC MP4 for WhatsApp. Clips remain bounded to 2–20 seconds.
Conversion uses a private temporary directory that is removed on completion or
failure. Existing `/clip` callers retain their original recording format.

## Saved recordings (experimental, off by default)

`RECORDINGS_ENABLED` enables two read-only endpoints only when set to `true`.
Both use the existing bearer authentication and `Cache-Control: no-store`.
With the flag absent or off, authenticated requests return 404.

- `GET /recordings?since=<ISO>&until=<ISO>&limit=<n>` returns
  `{ recordings: [{ id, startedAt, endedAt, durationSeconds, storage, eventType }],
  possiblyTruncated }`. Dates accept `YYYY-MM-DD` (UTC) or a timestamp with a
  timezone. Defaults are the last 24 hours and 20 records; maximums are seven
  days and 100 records. List attempts, including failures, are limited to one
  per minute. A full page sets `possiblyTruncated`; pagination is not verified.
- `GET /recording/<id>` accepts an opaque handle from a successful list and
  returns `video/mp4`. Handles expire after 15 minutes or process restart.
  Output must be smaller than 25 MiB, have decodable video at 1–120 fps, and
  last at most approximately 20 seconds (20.5 seconds of timestamp tolerance).
  Longer events are rejected, not silently trimmed. Validation uses ffmpeg and
  ffprobe; the additional executable override is `FFPROBE_PATH`.

**This camera's saved recordings are not yet available through these routes.**
Real-account video and history requests currently return `null`, which the
adapter reports as HTTP 502 rather than an empty day. The implemented download
path supports only explicitly unencrypted cloud records whose URLs the SDK
already permits. It retains the SDK's stricter 10 MiB download limit, host
allowlist, redirect rules, and timeout. Local P2P downloads and encrypted cloud
files return 501 pending protocol verification. Unknown/expired handles return
404, overlapping downloads 409, and rate-limited lists 429. Failures use
`{ error }` without upstream URLs, keys, or account data.

The adapter reuses the SDK session and verifies device ownership. It never
opens a live stream or sends a settings command. Cloud reads do not use P2P;
any future local adapter must use the existing `media.exclusive` lock.
See [recordings research](docs/RECORDINGS_RESEARCH.md) for observed responses,
unsupported cases, and the remaining real-camera acceptance checks. Enabling
the flag is not evidence that this camera's recordings can be downloaded.
