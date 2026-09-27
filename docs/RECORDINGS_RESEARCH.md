# Saved recordings research — 2026-09-27

Status: **real listing, saved transfer, decryption and MP4 validation passed**.
The branch implements the verified local path. Production remains on its prior
build with the feature off; validation ran within the existing process's media
lock, with no login, deployment, setting change or session export.

## 1. Actual storage and matching recording

The owner's T86P2 returned `storage_type: 1`, `storage_cloud: 0` for both a
16:23:44 event and the owner's exact known playable event:
**2026-09-27 15:22:34–15:22:44 CDT (20:22:34–20:22:44 UTC)**.
This proves local camera storage for these events, not cloud storage. The latter
row reports `frame_num: 158`, `cipher_id: 0`, `video_type: 2`. A captured,
explicitly redacted fixture is `fixtures/recording-local-captured.json` at the
repository root. Serial, path and recording ID are replaced, and account fields
are omitted. No captured video or key is committed.

## 2. Verified requests and pagination

With the owner's explicit permission, 55 seconds of iPhone Eufy control traffic
were filtered to the Eufy process, transferred directly into the existing
Railway container, and decoded in memory against its session. No raw capture
was written; media and other apps' traffic were excluded. The working app uses
an AES-128-ECB level-1 command 1350 envelope:

```json
{
  "cmd": 1306,
  "account_id": "REDACTED_OWNER",
  "payload": {
    "cmd": 10017,
    "table": "history_record_info",
    "transaction": "REDACTED",
    "payload": {
      "count": 20,
      "start_date": "20260927",
      "end_date": "20260928",
      "start_time": "0",
      "event_type": 0,
      "ai_type": 0,
      "storage_cloud": -1,
      "detection_type": 0,
      "flag": 0
    }
  }
}
```

The phone also sent a numeric `trigger_type`; its value was not retained.
The successful bridge query omits it, `device_info`, and `res_unzip`. The SDK
adds its existing channel fields. Crucially, `start_time` is a descending
pagination cursor: **`"0"` starts the first page; midnight does not**. The
phone's subsequent cursors included `20260927160917` and `20260927155935`.
The targeted bridge cursor `20260927152235` returned the 15:22:34 event.
Command 1306 replies with `cmd: 10017`, `mIntRet: 0`, and table wrappers:
`data: [{ table_name: "history_record_info", payload: [record, ...] }]`.
The implementation verifies standalone camera ownership and every row's device
and station serial before projecting metadata. Civil dates use America/Chicago
by default; ambiguous DST timestamps fail explicitly.

Saved download uses **1024**, not live-stream command 1003. Its level-1-encrypted
body is five zero bytes, the saved `storage_path` padded to 128-byte blocks,
and the similarly padded owner ID. The camera acknowledges command 1024 with
result code 0 followed by a 32-byte timestamp field. Command 1303 announces the
transfer; binary channel 3 carries video 1300 and audio 1301; command 1304
confirms completion. Cancellation uses 1051. The exact phone download request
was not recovered from the bounded capture; this download sequence was instead
validated directly against the known owner recording and app decoder.

## 3. Encryption and packet completeness

**Cipher ID 0 does not mean plaintext video.** The key is derived from camera
serial, P2P DID, and the ten-digit timestamp in the **download acknowledgment**.
It is not the event's timestamp. Static examination of the app decoder's
`zx_p2p_download_set_ts`/`gen_pic_code_v1` confirmed this derivation. The pinned
SDK already exports the same `getImageKey` primitive; use the first 16 ASCII
bytes of its uppercase hexadecimal result as the AES-128-ECB key. Sign-1
saved-video frames encrypt their first 128 media bytes, following the 22-byte
frame header. The remainder is clear H.265. This format does not carry the
RSA envelope assumed by the SDK's live-video decoder. No cloud cipher lookup
is necessary for this verified path. The exploratory cipher-0 lookup returned
no key. Keys stay in memory and never enter logs or API responses.

SDK 0.1.2 discards reordered datagrams and split frame headers. That yielded
missing keyframes and, later, one missing reference frame despite a successful
finish notification. The scoped adapter acknowledges, deduplicates and orders
packets, and reconstructs complete headers and payloads with bounded buffers.
It changes only the session instance under the bridge media lock, then restores
its handlers. Downloads require the real finish, the complete listed frame
count, no pending packets, increasing timestamps, and a clean full decode.
Timeouts cancel and close the session before releasing exclusivity.

The returned MP4 is video-only H.264, converted from complete H.265 frames.
Frame timestamps determine the rate because this camera reports header FPS 0.
Audio was observed but audio decryption/muxing is outside the verified adapter.

## 4. Hosts and limits

The verified recording listing and download use the SDK's existing P2P relay
transport; no recording HTTP URL, object store or new hostname is contacted.
Relay addresses are dynamically supplied by the existing cellular lookup,
not an added media allowlist. Their exact ephemeral IPs were not retained in
the sanitized validation output. Exploratory HTTP requests used
`security-app.eufylife.com` and `mysecurity.eufylife.com`; the historical log
below distinguishes their results. Railway's existing CLI/SSH service carried
validation control. No HTTP download allowlist was widened.

One list attempt per minute; at most seven requested days and 100 rows. Full
pages are explicitly marked as possibly truncated. Use an earlier `until` to
page backward. Download input and output stay below 25 MiB; recordings longer
than 20.5 seconds are rejected. The adapter requires the owner standalone T86P2,
local storage, cipher 0 and the verified H.265 frame form. Other formats fail
explicitly. The lossy cellular connection can still time out; this is not a
claim of guaranteed availability.

## 5. Real validation and release boundary

The actual implemented class listed the owner's 15:22:34 event, received
**158/158 video frames**, confirmed transfer completion with no pending bytes,
and observed a **10,459 ms** first-to-last-frame timestamp span. It returned
**1,880,645 bytes**, `ftyp` at offset 4, and passed ffprobe plus full ffmpeg
validation. Unlike the earlier diagnostic mux, this validation rejects decoder
error output as well as nonzero exit codes. The bridge remained ready, not busy,
in the same process; the temporary inspector was closed after each check.

The actual HTTP handlers were also mounted temporarily on a loopback-only
listener using the running owner session: unauthorized list returned 401;
authorized list returned 200 and the matching timestamp; download returned
200, `video/mp4`, `Cache-Control: no-store`, and the same validated MP4.
ffprobe reported 1280×720, rate `157000/10459` (about 15.011 fps), and duration
10.526 seconds. The listener was removed after validation. One earlier HTTP
attempt correctly returned 504 on a cellular calendar timeout. The isolated
Node 24/ffmpeg suite passes 68 tests, including off-by-default real-server routes.

The feature remains opt-in and off by default. No main merge, deployment or
production flag change has been performed. Neither Sage consumer was changed.
The historical failures below are preserved as an audit trail, not the current
status. In particular, prior empty local lists were caused by the wrong cursor,
and the initial cloud-only limitation has been superseded.

# Historical investigation log (superseded by the verified findings above)

Status: **experimental routes and a restricted cloud adapter implemented;
real-camera acceptance remains blocked on a verified recordings protocol**.
Read-only tests against the owner's existing Railway session confirmed camera
ownership, but did not obtain an event array. This is not evidence that
recordings are impossible. No feature deployment or new eufy login was made. Later bounded P2P
probes reached the calendar query but did not return records; see the follow-up below,
including a diagnostic-cleanup incident that restarted the bridge. The feature remains off by
default. Do not present the implementation as a working T86P2 recordings path.

## 1. Actual camera storage

**Unconfirmed.** Actual API responses did not contain any event records. The
app's ability to play a recording does not distinguish cloud storage from
microSD playback. Do not infer cloud storage from a thumbnail URL or from a
field named `storage_path`.

Read-only checks on the running service, with SDK 0.1.2 and its persisted session:

| Request | Observation |
| --- | --- |
| `POST /v2/event/app/get_all_video_record` | HTTP 401, SDK `MegaApiError`, code 26035. Meaning of that code unconfirmed. |
| `POST /v3/event/app/get_all_video_record`, owner-camera filter, shared/guest events excluded | SDK returned no array. |
| `POST /app/house/get_devs_list` on the US house service | Configured camera found; `member.admin_user_id` equals session user ID. No top-level numeric storage-status fields. |
| `POST /v3/event/app/get_all_video_record`, reference flags and resolved parent/device station filter | HTTP 200, envelope code 0, encrypted string `data` decrypted by SDK to `null`. |
| `POST /v3/event/app/get_all_history_record`, configured camera and station, shared/guest events excluded | SDK returned `null`, not an event array. |

Each list used a last-24-hours range and `num: 5`, not an account-wide request.
The third list used `shared: true` only after confirming camera ownership; the
device filter remained the configured camera. `null` is **not** a verified empty
event array. No storage classification, timestamp comparison, media URL, or
download can be derived from these responses. See the sanitized observation
fixture in `fixtures/recordings-api-observations.json`.

A subsequent read-only inventory check returned numeric parameters 1102=18334,
1182=0, 1192=8341, and 1193=8068. The SDK dictionary labels these `sdinfo`,
`devCloudStatus`, `detectedEvents`, and `recordingDays`. These labels and raw
numbers do not establish the storage location or availability of a particular
recording; no cloud-subscription or recording-disabled conclusion is drawn.

The pinned reference defines `StorageType` as NONE=0, LOCAL=1, CLOUD=2,
LOCAL_AND_CLOUD=3 (`src/http/types.ts`). Its event schema contains both
`storage_path` and `cloud_path`, as well as `hevc_storage_path` and
`storage_type`. In particular, a parser must account for storage type 3 rather
than assume every record has exactly one backing store. Choosing which backing
store to expose requires a verified download path.

No captured **record** fixture exists. The observation fixture records only
safe response metadata; it cannot validate a record parser. Synthetic records
must not be described as captured account responses.

## 2. Request sequences established by source

All reference links below are pinned to commit
`3bfef130bdcbff8f2f68286a5f63ec7e48177202` of
[`bropat/eufy-security-client`](https://github.com/bropat/eufy-security-client/tree/3bfef130bdcbff8f2f68286a5f63ec7e48177202).
They establish that client's implementation, **not the current official app's
traffic or compatibility with this camera/account**.

### Event list

[`src/http/api.ts`](https://github.com/bropat/eufy-security-client/blob/3bfef130bdcbff8f2f68286a5f63ec7e48177202/src/http/api.ts)
defines:

- `POST /v2/event/app/get_all_video_record` for `getVideoEvents`.
- `POST /v2/event/app/get_all_history_record` for `getHistoryEvents`.
- `getAllVideoEvents` simply requests a fifteen-year time range. It does not
  implement a pagination loop.

The logical list body is:

```js
{
  device_sn: targetCameraSerial,
  station_sn: targetStationSerial,
  start_time: Math.trunc(since.getTime() / 1000),
  end_time: Math.trunc(until.getTime() / 1000),
  exclude_guest: false,
  house_id: "HOUSEID_ALL_DEVICE",
  id: 0,
  id_type: 1,
  is_favorite: false,
  num: limit,
  pullup: true,
  shared: true,
  storage: 0,
  transaction: String(Date.now())
}
```

`shared: true` is the reference's value, not an approved choice for the bridge.
The bridge must scope requests to the configured owner's device, verify
ownership, and reject returned records for other devices. Whether the current
endpoint accepts `shared: false` must be verified. Do not copy the reference's
empty-device default, broad time range, or account-wide query behavior.

The reference checks HTTP 200 and envelope `code: 0`, decrypts envelope `data`,
and expects an array of `EventRecordResponse`. The schema in
[`src/http/models.ts`](https://github.com/bropat/eufy-security-client/blob/3bfef130bdcbff8f2f68286a5f63ec7e48177202/src/http/models.ts)
includes `monitor_id`, `start_time`, `end_time`, `video_type`, storage fields,
`cipher_id`, and `cipher_user_id`. It also contains credentials and device
identifiers; never return or log the raw response. Timestamp units, `video_type`
semantics, and identifier uniqueness still need actual response validation.

The old reference sends `X-Auth-Token` and application/device identity headers
including `App_version`, `Os_type`, `Os_version`, `Phone_model`, `Country`,
`Language`, `Openudid`, `Net_type`, `Mnc`, `Mcc`, `Sn`, `Model_type`, and
`Timezone`. Their necessity for the current app is unconfirmed.

The installed SDK 0.1.2 exposes `EufyMega.api.securityAppPost(path, body)`.
It reuses the SDK account session, chooses the region's security-app host, and
handles ECDH transport encryption. Its emitted header names include:

- `x-auth-token`, `authorization`, `gtoken` (MD5 of the account user ID).
- `app-name`, `app-version`, `app_version`, `os-type`, `os_type`, `os-version`,
  `os_version`, `phone-model`, `phone_model`, `model-type`, `country`, `ab_code`,
  `openudid`, `language`, `test-flag`, `user-agent`, `accept`, `accept-charset`.
- `content-type`, `x-encryption-info`, `x-replay-info`, `x-key-ident`,
  `x-request-ts`, `x-request-once`, `x-signature`.

For eufylife hosts it prefers `text/plain` and exchanges a separate host key via
`/v3/openapi/oauth/key/exchange` as necessary. The encrypted request body and
signature must be produced by the SDK, not copied from another session. The
SDK's v3 cipher/face endpoints do **not** prove that a v3 recordings endpoint
exists or that its signed transport accepts the reference's v2 event endpoint.
The v2 and v3 list trials above used this exact SDK transport. Neither produced
records. A null response must not be silently normalized to a successful empty
recordings list.

The implemented adapter uses the v3 video endpoint already contacted, with
`shared: false`, `exclude_guest: true`, and the configured camera/station.
It returns a sanitized array only for an actual array response; the observed
null response yields HTTP 502. This is intentionally experimental, not a claim
that the current official app uses that endpoint successfully.

### Local download

The cited task's station path needs correction: at this commit `startDownload`
is in
[`src/http/station.ts`](https://github.com/bropat/eufy-security-client/blob/3bfef130bdcbff8f2f68286a5f63ec7e48177202/src/http/station.ts),
not `src/p2p/station.ts`.

For the non-HB3 branch, the reference optionally fetches a cipher using
`POST /v2/app/cipher/get_ciphers` with logical body
`{ cipher_ids: [cipherId], user_id: stationAdminUserId, transaction }`. It loads
the returned RSA private key into the download channel. It then sends P2P
`CMD_DOWNLOAD_VIDEO` with the recording path, station admin user ID, and device
channel. No live-video start is necessary in this reference branch.

[`src/p2p/session.ts`](https://github.com/bropat/eufy-security-client/blob/3bfef130bdcbff8f2f68286a5f63ec7e48177202/src/p2p/session.ts)
handles `CMD_CONVERT_MP4_OK`, the BINARY data channel, video/audio frames, and
`CMD_DOWNLOAD_FINISH`. Cancellation uses `CMD_DOWNLOAD_CANCEL`. A finished
download channel is not itself proof of a complete, playable MP4; decrypted
frames still require muxing and validation. HB3 has a separate implementation
with an explicit unsupported/account-error TODO. Neither branch proves T86P2
support. The bridge SDK lacks an equivalent saved-recording download surface.

### Cloud download

**Unconfirmed.** The examined event-list and station-download implementations
do not establish a cloud MP4 fetch sequence, URL construction, authentication
requirements, or cloud-file decryption algorithm. `cloud_path` is a schema
field, not evidence that fetching it directly is correct.

The SDK's push-media `downloadMedia(url)` sends `x-auth-token`, `gtoken`,
`app-name`, `model-type`, and `user-agent` to an allowed security-app host. It
allows one redirect to an allowlisted object-store host without forwarding
credentials, enforces public DNS resolution, a 15-second timeout, and a **10
MiB** streaming byte limit. It is not a 25 MiB recordings downloader. Its
`downloadImage` wrapper additionally decodes recognized push-image data; that
does not establish a video decryption path.

## 3. Encryption and keys

API envelope encryption and media encryption are separate layers.

For the reference P2P download path, the station's cipher response supplies an
RSA private key. The session parser decrypts an embedded RSA-wrapped AES key,
then decrypts the first 128 encrypted video-payload bytes with AES-ECB and no
padding, retaining the remaining bytes. See `CMD_VIDEO_FRAME` handling and
`decryptAESData` in
[`src/p2p/utils.ts`](https://github.com/bropat/eufy-security-client/blob/3bfef130bdcbff8f2f68286a5f63ec7e48177202/src/p2p/utils.ts).
This is evidence about that reference frame format, not arbitrary cloud MP4s.

The bridge SDK has `getCiphers(cipherIds, userId, stationSn)` using
`/v3/app/cipher/get_ciphers`; its declared result includes RSA and ECC private
keys. Availability of the required recording key on this account is
unconfirmed. No key material was requested, read, or stored during research.

## 4. Hosts

Observed eufy API hosts, recorded from the remote process's fetch calls:

- `security-app.eufylife.com`: security-host key exchange and event-list calls.
- `app-house-us-pr.eufy.com`: read-only inventory/ownership checks.

**No recording download host was contacted.** No URL was obtained. Source
fetches used `github.com` and `raw.githubusercontent.com`. Railway CLI/package
and SSH infrastructure was also used; its complete internal host set was not
captured and is not a recording download path.

Source-only download candidates, **not observed recording hosts**:

- SDK US security API: `security-app.eufylife.com`.
- SDK non-US security API: `security-app-<region>.eufylife.com`.
- SDK media allowlist: security-app eufylife hosts for US, EU, and IE.
- SDK object allowlist: `zhixin-security-*` S3 bucket hosts, optionally with
  an AWS region. No concrete recording bucket or redirect was observed.

No allowlist was extended. A future extension needs exact observed hosts,
HTTPS-only validation, DNS/private-address protection, bounded streaming, and
redirect validation without leaking account headers across origins.

## 5. Pagination and rate limits

No rate-limit response or continuation token was observed. Four bounded list
attempts were made, including the later history check; the repeated v3 video
attempts were separated by more than one minute.
The reference defaults `num` to 1000 and sends
`id: 0`, `id_type: 1`, `pullup: true`; it does not demonstrate continuation
semantics. These values do not establish the server's maximum page size.

The implemented module bounds date ranges to seven days and limits to 100,
enforces 60 seconds between list attempts including failures, and rejects
overlap. A full page sets `possiblyTruncated`; no unsupported continuation
algorithm is implemented. A large series of production queries was not used
to discover pagination.

## 6. Remaining evidence and implementation boundary

The owner identified the Railway production service and authorized validation
inside its container with the session file kept on the persistent volume.
After explicit approval, this Mac's existing public SSH key was registered
with Railway as `sage-mac`; that registration remains in place. SSH then worked.
The remote probes loaded the persisted session into an SDK instance with empty
login credentials and a read-only session-store wrapper. They did not invoke
`login`, write the saved session, open P2P, or acquire the running bridge's media
lock. Raw SDK logs and errors were suppressed; only selected metadata was
printed. No session was copied out. Local `ffmpeg` and `ffprobe` are absent from
PATH; the repository Dockerfile supplies ffmpeg in production.

### Implemented independently of account availability

- Authenticated, no-store routes, absent by default; existing routes retain
  their behavior. No P2P or camera settings APIs are used.
- Owner/device-scoped listing, strict dates/ranges/limits, rate limiting,
  secret-free field projection, opaque 15-minute IDs and a bounded 500-entry
  in-memory lookup cache. No record URLs are accepted from API callers.
- A restricted cloud download path via the SDK's existing downloader, accepting
  only records with explicit `cipher_id: 0` and supported security-app HTTPS
  URLs. The SDK preserves its own DNS, host, redirect and 10 MiB limits.
  Local records, unknown/encrypted ciphers, direct object-store URLs, and
  oversized-duration records fail explicitly before download.
- A second strict 25 MiB output ceiling, `ftyp` check, ffprobe metadata checks,
  and complete ffmpeg video decoding. Frame rate must be 1–120 fps; duration
  must not exceed 20.5 seconds; decoded frame count/time are also bounded.
  The validator rejects video above 4K pixel count, limits output and runtime,
  disables external MP4 data references, and deletes private temporary files.
- Docker runtime packaging, README, source attribution, and tests for the
  captured null response, synthetic record schemas, authentication, flag-off,
  malformed requests, ownership, concurrency, redaction, byte limits, actual
  media decoding, and absence of settings/live command references.

New environment variable names: `RECORDINGS_ENABLED`, `FFPROBE_PATH`. No new
runtime dependencies. Test MP4s are generated synthetic footage, not camera
footage. Tests against synthetic records do not establish protocol support.

Validation: `npm test` passed all 46 tests in an isolated Node 24 / Debian
ffmpeg container with networking disabled and no production credentials.
This includes the full existing suite and actual media decode tests. The
initial high-fps synthetic fixture was corrected to request its output rate
explicitly because ffmpeg rounded an input rate of 121 to an output of 120.
`git diff --check` passed. No production code or feature flag was changed.

### Remaining real-camera work

1. With the owner present, observe the official app listing and playing one
   event on this camera. Retain request shapes only, not tokens or account
   identifiers. Alternatively obtain a verified current implementation of
   that API. Repeat one scoped list request through the SDK session and retain
   a redacted record fixture; compare timestamps with the app. Confirm storage.
2. Establish the actual download path, concrete hosts, and media encryption.
   For local storage, implement the download channel under `media.exclusive`
   with cleanup on timeout/cancellation; do not fall back to a live stream.
3. Fetch one bounded recording. Validate MP4 `ftyp` at offset 4, a video stream,
   decodable frames, 1–120 fps, approximately 20 seconds maximum, and the
   consumer's byte limit. Reject longer recordings or explicitly define a
   bounded excerpt contract; do not silently misreport full-record duration.
4. Add captured-record fixtures and validate the actual list and download
   routes against the app. Extend the adapter only with the verified protocol,
   then repeat the tests and real-camera acceptance checks.

No real-account recording acceptance checks have passed. Unusable list responses
are not a finding that recordings are disabled, encrypted beyond recovery, or
impossible. No recommendation to alter recording settings is justified.

The current upstream SDK was also inspected at commit
`52490349627c9a177d87a2b1e67b2b43dd50cbc1`. It still provides no stored-recording
enumeration/download API. Its on-station database query primitive is not a
verified T86P2 recording schema or download protocol. The dependency remains
pinned to 0.1.2.

## Follow-up: official portal and live validation

The owner confirmed the app uses **CDT (UTC−05:00)**. Its September 27 day
starts at `2026-09-27T05:00:00Z`. The app did not show the recording source.
The earlier last-24-hours queries covered that interval, but no record was
returned to compare with the app. Actual storage remains unconfirmed.

The public [Eufy web portal](https://mysecurity.eufylife.com/) was inspected,
including `main.b92d60ec.chunk.js` and `26.5a1e15b6.chunk.js`. This establishes
**published web-client behavior**, not a captured mobile-app request sequence:

- It lists `POST /v3/event/app/get_all_video_record` with `device_sn`, epoch
  seconds `start_time`/`end_time`, `offset` in **seconds**, `id: 0`, `num`,
  `pullup: true`, `shared: true`, and `storage: 2` for cloud events. A scoped
  trial with the configured camera, `num: 5`, UTC offset zero, and the SDK's
  default application identity still returned decrypted `null`.
- Web requests use `App-Name: eufy_security`, `Model_type: WEB`, `Web-Country`,
  the existing account token/gtoken, and ECDH encryption/signature headers.
  Changing the SDK request's application identity returned HTTP 401.
  The initial bootstrap probe returned HTTP 403 because it accidentally sent
  duplicate replay headers (`X-Replay-Info` and `x-replay-info`). After fixing
  the probe, the public WEB key exchange succeeded with HTTP 200/code 0 both
  locally and from Railway. The subsequent authenticated event request with
  the existing session still returned HTTP 401. The reason is **unconfirmed**;
  this does not prove token expiry,
  lack of a subscription, or unavailable recordings. No login was attempted.
- For applicable encrypted cloud records, the portal decodes `extra` and sends
  `POST /v3/web/cipher/dec_aes_keys` with `user_id` and a `cipher_keys` array.
  Each entry contains `cipher_id` and `aes_keys: { uuid, [uuid]: extra.aes_key }`.
  It selects the returned key by cipher ID and UUID. The portal then fetches
  `cloud_path` and processes versioned frame wrappers before muxing video and
  audio to MP4. Its cloud path is not generally a directly playable MP4.
- Another branch refreshes `cloud_path` using
  `POST /v3/event/app/get_kvs_urls` with `monitor_ids` and `user_id`.
  Neither key endpoint nor any video URL was called: no event record was
  available. Concrete download hosts and successful media decryption remain
  unconfirmed. The draft's restricted unencrypted downloader does not implement
  this encrypted playback path.

A read-only local calendar probe was prepared from the reference's
`CMD_DATABASE_QUERY_BY_DATE` (10006), nested under database command 1306,
for `history_record_info`, configured-device scope, and a five-record cap.
Two attempts used the **running bridge's existing `media.exclusive` lock**.
Both failed before `queryDatabase` was reached; a later source audit showed
that `openStation()` starts a handshake but does not await connection. The
probe must use `ensureStation()` before sending the query. Consequently these
initial failures do not establish a transport failure. In those attempts,
no recording database reply was received. The first had a 20-second cap; the
second had a 35-second cap and returned an SDK error before that cap. Its exact
cause was not retained, so it must not be described as a proven network timeout
or unsupported database command. No live stream or settings command was issued
by the probes. The cached battery subsequently read 18%, not charging.

### Diagnostic incident

A temporary, loopback-only Node debugger was used to schedule those probes
inside the existing lock. Its cleanup attempted a dynamic `import` in the
inspector evaluation context. Node rejected that with
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`; the unhandled rejection caused three
bridge restarts, including the preliminary scope check. Railway restarted the
service and it returned to authenticated/ready state. The debugger was confirmed
closed. That cleanup implementation was stopped and must not be reused. A replacement
uses synchronous `process.getBuiltinModule("inspector").close()` and was tested
through three isolated Node 24 success/failure cycles before further live use.
Subsequent live checks verified an unchanged process start time, a closed
inspector, and a ready bridge after cleanup. No session file was
copied or printed, no feature flag was enabled, and no feature build was deployed.
The saved session was reused by normal bridge startup; no new login was requested
by the probe. These restarts were an operational side effect, not a successful
validation and not an intentional deployment.

The follow-up still does **not** meet the real-recording acceptance criteria.
The next missing evidence is the successful app's list/playback request sequence
for this camera. No claim that cloud videos are accessible is justified.

## Subsequent bounded protocol checks

`recordings-local.js` is an experimental, unmounted calendar adapter using
10017. It is not a working download implementation. It verifies
owner and standalone camera scope, acquires the existing media lock, awaits
`ensureStation()`, permits one cold-connection retry under the same 35-second
deadline, and closes only a session it created. Tests cover ownership, foreign
rows, cancellation, listener cleanup, the media lock, and civil dates in
`America/Chicago` (the owner's app uses CDT).

A calendar request reached the camera. A second diagnostic used empty
`device_info` only after verifying that the station is the configured standalone
owner camera; this matches a successful HB3 reference probe but does not prove
T86P2 compatibility. Numeric frame metadata showed command 1350 acknowledgment,
gateway info 1100, and command 6053. No 1306 database frame or `dbChunk` arrived
before the bounded timeout. A subsequent 10006 acknowledgment decoded to
result code 0, still without a database reply. Thus a missing JSON decoder alone
does not explain those attempts. Busy responses were respected and did not send calendar commands.

The alternate read-only local query 10017 **did** return command 1306, sign 0,
JSON `cmd: 10017`, `mIntRet: 0`, and an empty data list. This occurred both with
an empty device filter for today's civil day and with the exact configured
camera filter for September 26–27. Response fields were `start_id`, `end_id`,
`data`, `transaction`, `table`, `cmd`, `mIntRet`, `version`, and `msg`.
Unlike cloud `null`, this is a successful empty database response, but it does
not explain the recordings visible in the owner's iPhone app. This legacy
command returns table wrappers (`table_name`/`payload`) for nonempty data, not
the flat 10006 row shape; synthetic tests are labeled accordingly.

A separate HTTP request with storage 1, the configured camera, a five-record cap,
and today's CDT boundary/offset also returned decrypted `null`. No saved video
has yet been retrieved. These observations are not evidence of an empty camera
or a permanent inability to retrieve recordings.

The read-only day query 10008 returned 13 entries, including September 27,
each with `count: 1`. It also returned dates preceding the requested September
20 boundary. Therefore the values may be presence flags and the date filter
cannot be assumed enforced. The camera has a recordings day index even though
the local row query is empty. The owner identified a playable iPhone recording
at **2026-09-27 15:22:34 CDT = 20:22:34 UTC**; no bridge result has matched it yet.
The SDK basic history read 10000 acknowledged code 0 without a database reply;
combined query 10009 returned `mIntRet: -1006` (meaning unconfirmed). These are
read-only database operations, not settings commands. Sanitized observations
are in `fixtures/recordings-local-observations.json`.

The expanded suite passes **57 tests** in isolated Node 24 with ffmpeg. This
verifies implementation guards, not the missing actual recording/download.

## Consumer changes requiring a separate decision

`sage-whatsapp` would need to distinguish the recording's capture time from
retrieval time and avoid presenting saved footage as a fresh observation.
`sage-booth-analytics` would need recording-ID deduplication, coverage and gap
reporting, and an explicit owner-approved sampling policy. Motion-triggered
events are not equivalent to the current fixed five-minute samples and cannot
silently replace them in booth traffic metrics. Neither consumer was modified.
