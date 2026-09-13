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
