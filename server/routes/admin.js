const express = require('express');
const { getDb } = require('../db');
const { getConfig } = require('../utils/config');
const { requireAdminSession } = require('../middleware/adminSession');
const { isTotpEnabled, verifyTotp } = require('../utils/adminLogin');
const { addToQueue } = require('../utils/spotify')
const engine = require('../utils/autoEngine');
const spotify = require('../utils/spotify');
const { verifyAdminPassword, upgradePasswordToHashIfNeeded } = require('../utils/adminPassword');

const router = express.Router();
const db = getDb();

// Cooldown is shared across fingerprints linked to the same GitHub/Google account.
function getCooldownFingerprintIds(fingerprint) {
  if (fingerprint.github_id) {
    return db.prepare('SELECT id FROM fingerprints WHERE github_id = ?').all(fingerprint.github_id).map(r => r.id);
  }
  if (fingerprint.google_id) {
    return db.prepare('SELECT id FROM fingerprints WHERE google_id = ?').all(fingerprint.google_id).map(r => r.id);
  }
  return [fingerprint.id];
}

router.post('/login', (req, res) => {
  const { password, totp } = req.body || {};
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  if (isTotpEnabled()) {
    if (!verifyTotp(totp)) {
      return res.status(401).json({ error: 'Invalid or missing TOTP code', totpRequired: true });
    }
  }
  upgradePasswordToHashIfNeeded(password);
  req.session.regenerate((regErr) => {
    if (regErr) {
      console.error('Session regenerate error:', regErr);
      return res.status(500).json({ error: 'Session failed' });
    }
    req.session.adminAuthenticated = true;
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.status(500).json({ error: 'Session failed' });
      }
      res.json({ success: true, authenticated: true });
    });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('spotiqueue.admin.sid', { path: '/' });
    res.json({ success: true });
  });
});

router.get('/session', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.adminAuthenticated),
    totpRequired: isTotpEnabled()
  });
});

router.use(requireAdminSession);

// Get all devices (fingerprints)
router.get('/devices', (req, res) => {
  const { status, sort = 'last_queue_attempt' } = req.query;
  const SORT_COLUMNS = new Set(['last_queue_attempt', 'first_seen', 'cooldown_expires', 'created_at', 'username', 'status']);
  const sortColumn = SORT_COLUMNS.has(sort) ? sort : 'last_queue_attempt';

  let query = 'SELECT * FROM fingerprints';
  const params = [];

  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }

  query += ` ORDER BY ${sortColumn} DESC LIMIT 100`;

  const devices = db.prepare(query).all(...params);

  const now = Math.floor(Date.now() / 1000);

  const devicesWithStatus = devices.map(device => {
    const isCoolingDown = device.cooldown_expires && device.cooldown_expires > now;
    const cooldownRemaining = isCoolingDown ? device.cooldown_expires - now : 0;

    return {
      ...device,
      is_cooling_down: isCoolingDown,
      cooldown_remaining: cooldownRemaining,
      display_id: device.id.substring(0, 8) + '...'
    };
  });

  if (sortColumn === 'last_queue_attempt') {
    devicesWithStatus.sort((a, b) => {
      if (a.username && !b.username) return -1;
      if (!a.username && b.username) return 1;
      return (b.last_queue_attempt || 0) - (a.last_queue_attempt || 0);
    });
  }

  res.json({ devices: devicesWithStatus });
});

// Get device details
router.get('/devices/:id', (req, res) => {
  const { id } = req.params;
  const { limit = '100' } = req.query;
  const limitNum = parseInt(limit, 10);

  const device = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const attempts = db.prepare(`
    SELECT * FROM queue_attempts
    WHERE fingerprint_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(id, limitNum);

  const totalAttempts = db.prepare(`
    SELECT COUNT(*) as count FROM queue_attempts WHERE fingerprint_id = ?
  `).get(id).count;

  res.json({ device, attempts, total_attempts: totalAttempts });
});

// Reset cooldown for a device
router.post('/devices/:id/reset-cooldown', (req, res) => {
  const { id } = req.params;

  const device = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  const now = Math.floor(Date.now() / 1000);
  const cooldownDuration = parseInt(getConfig('cooldown_duration') || '300', 10);
  const cooldownWindowStart = now - cooldownDuration;
  const cooldownIds = getCooldownFingerprintIds(device);
  const placeholders = cooldownIds.map(() => '?').join(',');

  const resetCooldownAndWindowCount = db.transaction(() => {
    db.prepare(`
      UPDATE fingerprints
      SET cooldown_expires = NULL
      WHERE id IN (${placeholders})
    `).run(...cooldownIds);

    // Keep historical rows but move recent successful attempts outside cooldown window.
    db.prepare(`
      UPDATE queue_attempts
      SET timestamp = ?
      WHERE fingerprint_id IN (${placeholders})
        AND status = 'success'
        AND timestamp > ?
    `).run(cooldownWindowStart - 1, ...cooldownIds, cooldownWindowStart);
  });

  resetCooldownAndWindowCount();

  res.json({ success: true, message: 'Cooldown reset' });
});

// Block a device
router.post('/devices/:id/block', (req, res) => {
  const { id } = req.params;

  const device = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  db.prepare('UPDATE fingerprints SET status = ? WHERE id = ?').run('blocked', id);

  res.json({ success: true, message: 'Device blocked' });
});

// Unblock a device
router.post('/devices/:id/unblock', (req, res) => {
  const { id } = req.params;

  const device = db.prepare('SELECT * FROM fingerprints WHERE id = ?').get(id);
  if (!device) {
    return res.status(404).json({ error: 'Device not found' });
  }

  db.prepare('UPDATE fingerprints SET status = ? WHERE id = ?').run('active', id);

  res.json({ success: true, message: 'Device unblocked' });
});

// Reset all cooldowns
router.post('/devices/reset-all-cooldowns', (req, res) => {
  db.prepare('UPDATE fingerprints SET cooldown_expires = NULL').run();

  res.json({ success: true, message: 'All cooldowns reset' });
});

// Get banned tracks
router.get('/banned-tracks', (req, res) => {
  const tracks = db.prepare('SELECT * FROM banned_tracks ORDER BY created_at DESC').all();
  res.json({ tracks });
});

// Add banned track
router.post('/banned-tracks', (req, res) => {
  const { track_id, artist_id, reason } = req.body;

  if (!track_id) {
    return res.status(400).json({ error: 'Track ID required' });
  }

  try {
    db.prepare(`
      INSERT INTO banned_tracks (track_id, artist_id, reason)
      VALUES (?, ?, ?)
    `).run(track_id, artist_id || null, reason || null);

    res.json({ success: true, message: 'Track banned' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Track already banned' });
    }
    throw error;
  }
});

// Remove banned track
router.delete('/banned-tracks/:trackId', (req, res) => {
  const { trackId } = req.params;

  const result = db.prepare('DELETE FROM banned_tracks WHERE track_id = ?').run(trackId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Banned track not found' });
  }

  res.json({ success: true, message: 'Track unbanned' });
});

// Get public client URL (for QR code generation)
router.get('/client-url', (req, res) => {
  const url = getConfig('queue_url') || process.env.CLIENT_URL || 'http://localhost:3000';
  res.json({ url });
});

// Get queue statistics
router.get('/stats', (req, res) => {
  const totalDevices = db.prepare('SELECT COUNT(*) as count FROM fingerprints').get().count;
  const activeDevices = db.prepare("SELECT COUNT(*) as count FROM fingerprints WHERE status = 'active'").get().count;
  const blockedDevices = db.prepare("SELECT COUNT(*) as count FROM fingerprints WHERE status = 'blocked'").get().count;

  const now = Math.floor(Date.now() / 1000);
  const coolingDown = db.prepare('SELECT COUNT(*) as count FROM fingerprints WHERE cooldown_expires > ?').get(now).count;

  const totalAttempts = db.prepare('SELECT COUNT(*) as count FROM queue_attempts').get().count;
  const successfulAttempts = db.prepare("SELECT COUNT(*) as count FROM queue_attempts WHERE status = 'success'").get().count;

  res.json({
    devices: {
      total: totalDevices,
      active: activeDevices,
      blocked: blockedDevices,
      cooling_down: coolingDown
    },
    queue_attempts: {
      total: totalAttempts,
      successful: successfulAttempts
    }
  });
});

// Reset all data (devices, stats, banned tracks - but NOT config)
router.post('/reset-all-data', (req, res) => {
  try {
    const resetData = db.transaction(() => {
      db.prepare('DELETE FROM queue_attempts').run();
      db.prepare('DELETE FROM fingerprints').run();
      db.prepare('DELETE FROM banned_tracks').run();
    });

    resetData();

    res.json({
      success: true,
      message: 'All data has been reset. Devices, stats, and banned tracks have been cleared.'
    });
  } catch (error) {
    console.error('Error resetting data:', error);
    res.status(500).json({ error: `Failed to reset data: ${error.message}` });
  }
});

router.post('/toggle-engine', async (req, res) => {
  try {
    const isRunning = engine.getStatus();

    if (isRunning) {
      engine.stopEngine();
      res.json({ message: "CrowdPlay Engine Stopped.", active: false });
    } else {
      engine.startEngine();
      res.json({ message: "CrowdPlay Engine Started! Songs will now auto-queue.", active: true });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to toggle engine' });
  }
});

// Also add a quick route so the frontend knows if the engine is currently running:
router.get('/engine-status', async (req, res) => {
  res.json({ active: engine.getStatus() });
});

// Remove a song from the local voting queue
router.delete('/queue/:trackId', (req, res) => {
  const { trackId } = req.params;
  const result = db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(trackId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Track not found in queue' });
  }
  res.json({ success: true, message: 'Track removed from queue' });
});

// Admin: Manually adjust votes (up or down)
router.post('/queue/:trackId/vote', (req, res) => {
  const { trackId } = req.params;
  const { delta } = req.body; // Expects { delta: 1 } or { delta: -1 }

  const result = db.prepare('UPDATE local_queue SET votes = votes + ? WHERE track_id = ?')
      .run(delta, trackId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Track not found' });
  }
  res.json({ success: true });
});

router.post('/playback/play', async (req, res) => {
  await spotify.resumePlayback();
  res.json({ success: true });
});

router.post('/playback/pause', async (req, res) => {
  await spotify.pausePlayback();
  res.json({ success: true });
});

router.get('/spotify/devices', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const devices = await spotify.getDevices(forceRefresh);
    res.json(devices);
  } catch (error) {
    console.error('Failed to clear device list payload:', error.message);
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// Playback Controls with Error Catching
router.post('/playback/toggle', async (req, res) => {
  try {
    const current = await spotify.getNowPlaying();
    if (!current) return res.status(404).json({ error: 'No active device. Play a song on Spotify first!' });

    if (current.is_playing) {
      await spotify.pausePlayback();
    } else {
      await spotify.resumePlayback();
    }
    res.json({ success: true, isPlaying: !current.is_playing });
  } catch (e) {
    // Forward the EXACT error from Spotify instead of a generic message
    const spotifyError = e.response?.data?.error?.message || 'Playback control failed';
    res.status(500).json({ error: `Spotify says: ${spotifyError}` });
  }
});

router.post('/playback/next', async (req, res) => {
  try {
    if (engine.getStatus()) {
      await engine.triggerManualSkip(); // Use the engine's skip logic
      res.json({ success: true, message: 'Engine skip triggered' });
    } else {
      await spotify.skipPlayback();
      res.json({ success: true });
    }
  } catch (e) {
    res.status(500).json({ error: 'Skip failed' });
  }
});

// Add Playlist to Queue
router.post('/queue/add-playlist', async (req, res) => {
  const { url } = req.body;
  // Extract ID from URL (e.g., https://open.spotify.com/playlist/ID)
  const playlistId = url.split('playlist/')[1]?.split('?')[0];

  if (!playlistId) return res.status(400).json({ error: 'Invalid Playlist URL' });

  try {
    const tracks = await spotify.getPlaylistTracks(playlistId);
    const insert = db.prepare(`
      INSERT INTO local_queue (track_id, track_name, artist_name, album_art, votes) 
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(track_id) DO NOTHING
    `);

    const insertMany = db.transaction((tracks) => {
      for (const t of tracks) insert.run(t.id, t.name, t.artists, t.album_art);
    });

    insertMany(tracks);
    res.json({ success: true, count: tracks.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to add playlist' });
  }
});

// Get all playlists for the connected account
router.get('/playlists', async (req, res) => {
  try {
    const playlists = await spotify.getUserPlaylists();
    res.json(playlists);
  } catch (e) {
    // This stops the crash and tells the frontend exactly what went wrong!
    console.error("Spotify Fetch Error:", e.message);
    res.status(500).json({ error: 'Failed to fetch playlists. Please reconnect your Spotify account.' });
  }
});

// Admin: Get live Spotify API traffic stats
router.get('/spotify/stats', (req, res) => {
  try {
    res.json(spotify.getApiStats());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API stats' });
  }
});

// Get tracks from a specific playlist
router.get('/playlists/:id/tracks', async (req, res) => {
  try {
    const tracks = await spotify.getPlaylistTracks(req.params.id);
    res.json(tracks);
  } catch (e) {
    // Add this line so your terminal tells us what is wrong!
    console.error("Backend Error fetching playlist tracks:", e.message);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});

router.post('/queue/add-playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;

  try {
    // 1. Fetch tracks from Spotify
    const tracks = await spotify.getPlaylistTracks(playlistId);

    if (!tracks || tracks.length === 0) {
      return res.status(400).json({ error: 'Playlist is empty or could not be found.' });
    }

    // 2. Use a transaction to add all tracks efficiently
    const insert = db.prepare(`
      INSERT INTO local_queue (track_id, track_name, artist_name, album_art, votes) 
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(track_id) DO NOTHING
    `);

    const addMany = db.transaction((trackList) => {
      for (const track of trackList) {
        insert.run(track.id, track.name, track.artists, track.album_art);
      }
    });

    addMany(tracks);

    res.json({
      success: true,
      message: `Added ${tracks.length} tracks to the queue!`,
      count: tracks.length
    });
  } catch (error) {
    console.error('Playlist add error:', error);
    res.status(500).json({ error: 'Failed to add playlist tracks to queue.' });
  }
});

// Admin: Add a single track to the queue (Bypasses all guest limits)
router.post('/queue/add', async (req, res) => {
  const { track_id } = req.body;
  if (!track_id) return res.status(400).json({ error: 'Track ID required' });

  try {
    const trackInfo = await spotify.getTrack(track_id);

    // Instantly add it to the queue without checking fingerprints or cooldowns
    db.prepare(`
      INSERT INTO local_queue (track_id, track_name, artist_name, album_art, votes) 
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(track_id) DO UPDATE SET votes = votes + 1
    `).run(track_id, trackInfo.name, trackInfo.artists, trackInfo.album_art);

    res.json({ success: true, message: 'Track added' });
  } catch (error) {
    console.error('Admin Queue Add Error:', error);
    res.status(500).json({ error: 'Failed to add track' });
  }
});

// Admin: Clear the entire voting queue
router.delete('/queue-clear', (req, res) => {
  try {
    const db = getDb();
    db.prepare('DELETE FROM local_queue').run();
    res.json({ success: true, message: 'Queue completely cleared' });
  } catch (error) {
    console.error('Error clearing queue:', error);
    res.status(500).json({ error: 'Failed to clear queue' });
  }
});

router.get('/now-playing', async (req, res) => {
  try {
    // KILLSWITCH: If the party/engine is stopped, DO NOT ask Spotify!
    if (!engine.getStatus()) {
      return res.json({ is_playing: false, stopped: true });
    }

    const current = await spotify.getNowPlaying();
    // Make sure we actually have an active item inside!
    if (!current || !current.item) return res.json({ is_playing: false });

    res.json({
      is_playing: current.is_playing,
      progress_ms: current.progress_ms,
      duration_ms: current.duration_ms,
      item: {
        id: current.item.id,
        name: current.item.name,
        artists: current.item.artists,
        album_art: current.item.album_art
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch now playing' });
  }
});

router.post('/start-party', async (req, res) => {
  const { deviceId } = req.body;
  try {
    // 1. Wake up the device
    await spotify.transferPlayback(deviceId);

    // 2. Turn on the Auto-Engine
    if (!engine.getStatus()) {
      engine.startEngine();
    }

    // 3. Load the first song
    const db = getDb();
    const topTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();

    if (topTrack) {
      // THE FIX: Pre-shoot the cache so all connected screens update instantly!
      spotify.overrideNowPlayingCache(topTrack);

      await spotify.playTrack(`spotify:track:${topTrack.track_id}`, deviceId);
      engine.setLoadedTrack(topTrack.track_id);
    }

    res.json({ success: true, message: "Party started! The first song is playing." });
  } catch (e) {
    console.error("Start Party Error:", e.response?.data?.error || e.message);
    res.status(500).json({ error: 'Failed to start party on this device.' });
  }
});

router.post('/stop-party', async (req, res) => {
  try {
    // 1. Stop the background Auto-Engine
    if (engine.getStatus()) {
      engine.stopEngine();
    }

    // 2. Tell Spotify to cut the music
    try {
      await spotify.pausePlayback();
    } catch (spotifyError) {
      // We quietly ignore this error! If the music is already paused,
      // or the speaker fell asleep, we don't want it to crash the Stop button.
      console.log("Note: Could not pause Spotify during stop-party (likely already paused).");
    }

    res.json({ success: true, message: "Party stopped and music paused." });
  } catch (e) {
    console.error("Stop Party Error:", e);
    res.status(500).json({ error: 'Failed to fully stop the party.' });
  }
});

module.exports = router;
