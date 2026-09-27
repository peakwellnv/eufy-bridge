# Saved recordings research — 2026-09-27

Status: **experimental routes and a restricted cloud adapter implemented;
real-camera acceptance remains blocked on a verified recordings protocol**.
Read-only tests against the owner's existing Railway session confirmed camera
ownership, but did not obtain an event array. This is not evidence that
recordings are impossible. No feature deployment or new eufy login was made. Later bounded P2P
connection probes failed before the calendar query; see the follow-up below,
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
  Exchanging a key using that identity returned HTTP 403. Reproducing the
  public portal's separate bootstrap protocol also returned HTTP 403, including
  with its exact exchange header shape and ordinary web-origin headers. The
  reason for rejection is **unconfirmed**; this does not prove token expiry,
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
Both failed while opening the P2P session, before `queryDatabase` was reached;
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
closed. This method was stopped and must not be reused. No session file was
copied or printed, no feature flag was enabled, and no feature build was deployed.
The saved session was reused by normal bridge startup; no new login was requested
by the probe. These restarts were an operational side effect, not a successful
validation and not an intentional deployment.

The follow-up still does **not** meet the real-recording acceptance criteria.
The next missing evidence is the successful app's list/playback request sequence
for this camera. No claim that cloud videos are accessible is justified.

## Consumer changes requiring a separate decision

`sage-whatsapp` would need to distinguish the recording's capture time from
retrieval time and avoid presenting saved footage as a fresh observation.
`sage-booth-analytics` would need recording-ID deduplication, coverage and gap
reporting, and an explicit owner-approved sampling policy. Motion-triggered
events are not equivalent to the current fixed five-minute samples and cannot
silently replace them in booth traffic metrics. Neither consumer was modified.
