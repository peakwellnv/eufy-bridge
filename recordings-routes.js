import { MediaError } from './media.js';

/** Mount only after the server's bearer middleware. Disabled means no routes. */
export function mountRecordings(app, recordings, enabled) {
  if (!enabled) return;
  const failure = (res, error) => res.status(error instanceof MediaError ? error.status : 502)
    .json({ error: error instanceof MediaError ? error.message : 'Recordings service unavailable' });
  app.get('/recordings', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json(await recordings.listRecordings(req.query)); }
    catch (error) { failure(res, error); }
  });
  app.get('/recording/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.type('video/mp4').send(await recordings.downloadRecording(req.params.id)); }
    catch (error) { failure(res, error); }
  });
}
