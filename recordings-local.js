import { MediaError } from './media.js';

// Read-only calendar protocol from bropat/eufy-security-client. The T86P2 returned an
// empty 10017 response; nonempty rows and downloads remain unverified.
const DATABASE = 1306;
const QUERY_LOCAL = 10017;

function dayAt(time, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(time));
  const part = name => parts.find(p => p.type === name).value;
  return part('year') + part('month') + part('day');
}

export function localCalendarQuery(cameraSn, query, timeZone = 'America/Chicago') {
  const start = dayAt(query.since, timeZone);
  const last = dayAt(query.until, timeZone);
  const next = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(4, 6)) - 1, Number(last.slice(6, 8)) + 1));
  return { count: query.limit, detection_type: 0, device_info: [{ device_sn: cameraSn }],
    end_date: next.toISOString().slice(0, 10).replaceAll('-', ''), event_type: 0,
    flag: 0, res_unzip: 1, start_date: start, start_time: start + '000000',
    storage_cloud: -1, ai_type: 0 };
}

function failure(stage, error) {
  if (error instanceof MediaError) return error;
  const reason = error?.name === 'AbortError' || error?.name === 'TimeoutError' ||
    /P2P connect timeout/.test(error?.message ?? '') ? 'timed out' : 'failed';
  return new MediaError(`Local recordings ${stage} ${reason}`, reason === 'timed out' ? 504 : 502);
}

/** Requires the running bridge's lock; never creates a second Eufy client. */
export async function readLocalRecordingRows({ eufy, media, device, cameraSn }, query,
  { signal = AbortSignal.timeout(35000), timeZone = 'America/Chicago' } = {}) {
  if (!media?.exclusive || device?.sn !== cameraSn ||
      device?.raw?.member?.admin_user_id !== eufy?.api?.auth?.userId)
    throw new MediaError('Local recordings require the configured camera owner session', 403);
  if (!Number.isFinite(query?.since) || !Number.isFinite(query?.until) ||
      query.until < query.since || query.until - query.since > 86400000 ||
      !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)
    throw new MediaError('Invalid local recording query', 400);
  const router = eufy.p2p;
  const parent = router.stationKeyOf(cameraSn);
  // Do not broaden a camera-scoped request to a shared HomeBase.
  if (parent !== cameraSn) throw new MediaError('Local recordings require a standalone camera', 501);
  const body = localCalendarQuery(cameraSn, query, timeZone);
  return media.exclusive(async () => {
    signal.throwIfAborted();
    const manager = router.manager;
    const existed = !!manager.get(parent);
    manager.retain(parent);
    let stage = 'connection';
    try {
      // openStation() only starts the handshake in SDK 0.1.2. Waiting on that
      // alone and immediately sending a query throws "not connected".
      try { await router.ensureStation(parent, signal); }
      catch (error) {
        // The same bounded cold-connection retry used by live media. Never
        // replace a pre-existing session, retry a query, or extend the deadline.
        if (existed || signal.aborted || !/P2P connect timeout|session closed before connecting/.test(error?.message ?? '')) throw error;
        await manager.close(parent);
        manager.retain(parent);
        await router.ensureStation(parent, signal);
      }
      signal.throwIfAborted();
      const session = manager.get(parent);
      if (!session?.isConnected) throw new MediaError('Local recordings connection is not ready', 503);
      stage = 'calendar query';
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, rows) => {
          if (settled) return;
          settled = true;
          session.off('data', onData);
          session.off('dbChunk', onChunk);
          session.off('error', onError);
          session.off('close', onClose);
          signal.removeEventListener('abort', onAbort);
          error ? reject(error) : resolve(rows);
        };
        const onError = () => finish(new MediaError('Local recordings connection failed'));
        const onClose = () => finish(new MediaError('Local recordings connection closed'));
        const onAbort = () => finish(new MediaError('Local recordings calendar query timed out', 504));
        const onChunk = chunk => {
          // SDK 0.1.2 exposes non-block-aligned level-1 database payloads
          // separately. Accept only complete bounded JSON, never partial rows.
          if (typeof chunk.text !== 'string' || Buffer.byteLength(chunk.text) > 1024 * 1024) return;
          try { onReply(JSON.parse(chunk.text.replace(/\0.*$/s, ''))); } catch {}
        };
        const onData = frame => {
          if (frame.commandId === 1350 && frame.dataType === 0 &&
              frame.type === 1 && Buffer.isBuffer(frame.data) && frame.data.length >= 4) {
            const code = frame.data.readInt32LE(0);
            if (code < 0) return finish(new MediaError('Camera rejected the recording request', 502));
          }
          if (frame.commandId === DATABASE) onReply(frame.json);
        };
        const onReply = reply => {
          if (!reply || (reply.cmd !== QUERY_LOCAL && reply.cmd !== undefined)) return;
          if (reply.mIntRet !== 0) {
            const error = new MediaError('Camera rejected the recording calendar query', 501);
            if (Number.isSafeInteger(reply.mIntRet)) error.cameraCode = reply.mIntRet;
            return finish(error);
          }
          if (reply.cmd !== QUERY_LOCAL) return;
          const tables = reply.data === '[]' ? [] : reply.data;
          if (!Array.isArray(tables) || tables.length > 8 ||
              tables.some(table => !table || !Array.isArray(table.payload) || table.payload.length > query.limit))
            return finish(new MediaError('Camera returned an invalid recording database response'));
          const rows = tables.filter(table => table.table_name === 'history_record_info').flatMap(table => table.payload);
          if (tables.length && !tables.some(table => table.table_name === 'history_record_info'))
            return finish(new MediaError('Camera returned no recording history table'));
          if (rows.length > query.limit ||
              rows.some(row => !row || row.device_sn !== cameraSn || row.station_sn !== parent))
            return finish(new MediaError('Camera returned an invalid or out-of-scope recording calendar'));
          finish(null, rows);
        };
        session.on('data', onData);
        session.on('dbChunk', onChunk);
        session.on('error', onError);
        session.on('close', onClose);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) return onAbort();
        try { session.queryDatabase('history_record_info', {
          accountId: device.raw.member.admin_user_id, channel: 0,
          innerCmd: QUERY_LOCAL, query: body,
        }); } catch (error) { finish(failure(stage, error)); }
      });
    } catch (error) { throw failure(stage, error); }
    finally {
      manager.release(parent);
      if (!existed) await manager.close(parent);
    }
  });
}
