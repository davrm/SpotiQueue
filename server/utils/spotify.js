const axios = require('axios');
const { getConfig } = require('./config');

let accessToken = null;
let tokenExpiresAt = 0;

// Centralized Caches with 'promise' locks to prevent the Thundering Herd
const CACHE = {
  nowPlaying: { data: null, expires: 0, promise: null },
  devices: { data: null, expires: 0, promise: null },
  queue: { data: null, expires: 0, promise: null }
};

function clearTokenCache() {
  accessToken = null;
  tokenExpiresAt = 0;
}

// Spotify API base URL
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// Handle Rate Limits Globally and read Spotify's required wait time
function handleRateLimit(error, cacheKey, defaultWaitMs = 15000) {
  if (error.response?.status === 429) {
    // Spotify tells us EXACTLY how many seconds to wait in the Retry-After header
    const retryAfterSeconds = parseInt(error.response.headers['retry-after'], 10);
    const penaltyMs = (retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : defaultWaitMs) + 1000; // Add 1s buffer

    console.log(`[Spotify Limit] 🚨 API Blocked! Locking ${cacheKey} for ${Math.round(penaltyMs / 1000)} seconds...`);
    CACHE[cacheKey].expires = Date.now() + penaltyMs;
  }
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (accessToken && tokenExpiresAt > now + 60) return accessToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;

  if (!clientId || !clientSecret) throw new Error('Spotify credentials not configured');

  try {
    if (refreshToken) {
      const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const response = await axios.post('https://accounts.spotify.com/api/token',
          new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${authHeader}` } }
      );

      accessToken = response.data.access_token;
      tokenExpiresAt = now + response.data.expires_in;
      return accessToken;
    }
    throw new Error('Refresh token missing');
  } catch (error) {
    console.error('Error getting access token:', error.response?.data || error.message);
    throw new Error('Failed to authenticate with Spotify');
  }
}

// --- CORE CACHED API CALLS ---

async function getNowPlaying() {
  const now = Date.now();
  if (CACHE.nowPlaying.expires > now) {
    const cachedData = CACHE.nowPlaying.data;
    if (cachedData && cachedData.is_playing) {
      return { ...cachedData, progress_ms: cachedData.progress_ms + (now - (CACHE.nowPlaying.expires - 2000)) };
    }
    return cachedData;
  }

  // PROMISE LOCK: If a request is already in flight, return that same promise to everyone!
  if (CACHE.nowPlaying.promise) return CACHE.nowPlaying.promise;

  CACHE.nowPlaying.promise = (async () => {
    try {
      const token = await getAccessToken();
      const userId = process.env.SPOTIFY_USER_ID;
      if (!userId) return null;

      const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/currently-playing`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.status === 204 || !response.data) return null;

      const track = response.data.item;
      const result = {
        id: track.id,
        name: track.name,
        artists: track.artists.map(a => a.name).join(', '),
        album: track.album.name,
        album_art: track.album.images[0]?.url || null,
        duration_ms: track.duration_ms,
        progress_ms: response.data.progress_ms,
        is_playing: response.data.is_playing
      };

      CACHE.nowPlaying.data = result;
      CACHE.nowPlaying.expires = Date.now() + 2000;
      return result;
    } catch (error) {
      if (error.response?.status === 401) accessToken = null;
      handleRateLimit(error, 'nowPlaying');
      return CACHE.nowPlaying.data;
    } finally {
      CACHE.nowPlaying.promise = null; // Unlock when finished
    }
  })();

  return CACHE.nowPlaying.promise;
}

async function getQueue() {
  const now = Date.now();
  if (CACHE.queue.expires > now) return CACHE.queue.data;
  if (CACHE.queue.promise) return CACHE.queue.promise;

  CACHE.queue.promise = (async () => {
    try {
      const token = await getAccessToken();
      const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/queue`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const result = {
        currently_playing: response.data.currently_playing ? {
          id: response.data.currently_playing.id,
          name: response.data.currently_playing.name,
          artists: response.data.currently_playing.artists.map(a => a.name).join(', '),
          album: response.data.currently_playing.album.name,
          album_art: response.data.currently_playing.album.images[0]?.url || null,
          duration_ms: response.data.currently_playing.duration_ms,
          uri: response.data.currently_playing.uri
        } : null,
        queue: (response.data.queue || []).map(track => ({
          id: track.id,
          name: track.name,
          artists: track.artists.map(a => a.name).join(', '),
          album: track.album.name,
          album_art: track.album.images[0]?.url || null,
          duration_ms: track.duration_ms,
          uri: track.uri
        }))
      };

      CACHE.queue.data = result;
      CACHE.queue.expires = Date.now() + 4000;
      return result;
    } catch (error) {
      handleRateLimit(error, 'queue');
      return CACHE.queue.data || { queue: [] };
    } finally {
      CACHE.queue.promise = null;
    }
  })();

  return CACHE.queue.promise;
}

async function getDevices() {
  const now = Date.now();
  if (CACHE.devices.expires > now) return CACHE.devices.data;
  if (CACHE.devices.promise) return CACHE.devices.promise;

  CACHE.devices.promise = (async () => {
    try {
      const token = await getAccessToken();
      const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      CACHE.devices.data = response.data.devices;
      CACHE.devices.expires = Date.now() + 4000;
      return response.data.devices;
    } catch (error) {
      handleRateLimit(error, 'devices');
      return CACHE.devices.data || [];
    } finally {
      CACHE.devices.promise = null;
    }
  })();

  return CACHE.devices.promise;
}

// --- STANDARD UNCACHED API CALLS ---

async function searchTracks(query, limit = 10) {
  const token = await getAccessToken();
  const response = await axios.get(`${SPOTIFY_API_BASE}/search`, { params: { q: query, type: 'track', limit }, headers: { 'Authorization': `Bearer ${token}` } });
  return (response.data.tracks?.items || []).map(track => ({
    id: track.id, name: track.name, artists: track.artists.map(a => a.name).join(', '), album: track.album.name, album_art: track.album.images[0]?.url || null, explicit: track.explicit, duration_ms: track.duration_ms, uri: track.uri
  }));
}

async function getTrack(trackId) {
  const token = await getAccessToken();
  const response = await axios.get(`${SPOTIFY_API_BASE}/tracks/${trackId}`, { headers: { 'Authorization': `Bearer ${token}` } });
  const track = response.data;
  return { id: track.id, name: track.name, artists: track.artists.map(a => a.name).join(', '), album: track.album.name, album_art: track.album.images[0]?.url || null, explicit: track.explicit, duration_ms: track.duration_ms, uri: track.uri };
}

function parseSpotifyUrl(url) {
  try {
    const match = url.match(/track\/([a-zA-Z0-9]+)/);
    if (match && match[1]) return match[1];
    if (url.startsWith('spotify:track:')) return url.split(':')[2];
    return null;
  } catch (e) { return null; }
}

async function addToQueue(trackUri, deviceId = null) {
  const token = await getAccessToken();
  const params = { uri: trackUri };
  if (deviceId) params.device_id = deviceId;
  await axios.post(`${SPOTIFY_API_BASE}/me/player/queue`, null, { params, headers: { 'Authorization': `Bearer ${token}` } });
  CACHE.queue.expires = 0; // Force queue to instantly refresh
  return true;
}

async function playTrack(trackUri, deviceId = null) {
  const token = await getAccessToken();
  const url = deviceId ? `${SPOTIFY_API_BASE}/me/player/play?device_id=${deviceId}` : `${SPOTIFY_API_BASE}/me/player/play`;
  await axios.put(url, { uris: [trackUri] }, { headers: { 'Authorization': `Bearer ${token}` } });
  CACHE.nowPlaying.expires = 0;
}

async function pausePlayback() {
  const token = await getAccessToken();
  await axios.put(`${SPOTIFY_API_BASE}/me/player/pause`, null, { headers: { 'Authorization': `Bearer ${token}` } });
  CACHE.nowPlaying.expires = 0;
}

async function resumePlayback() {
  const token = await getAccessToken();
  await axios.put(`${SPOTIFY_API_BASE}/me/player/play`, null, { headers: { 'Authorization': `Bearer ${token}` } });
  CACHE.nowPlaying.expires = 0;
}

async function skipPlayback() {
  const token = await getAccessToken();
  await axios.post(`${SPOTIFY_API_BASE}/me/player/next`, null, { headers: { 'Authorization': `Bearer ${token}` } });
  CACHE.nowPlaying.expires = 0;
}

async function getPlaylistTracks(playlistId) {
  try {
    const token = await getAccessToken();
    const response = await axios.get(`${SPOTIFY_API_BASE}/playlists/${playlistId}/tracks`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.data || !response.data.items) return [];

    // 1. STRICT FILTER: Must exist, must have an ID, and MUST be a 'track' (no podcasts!)
    const validItems = response.data.items.filter(item => {
      return item && item.track && item.track.id && item.track.type === 'track';
    });

    // 2. MAP SAFELY: Never assume arrays or objects exist
    return validItems.map(item => {
      const t = item.track;
      let imageUrl = null;

      if (t.album && t.album.images && t.album.images.length > 0) {
        imageUrl = t.album.images[0].url;
      }

      return {
        id: t.id,
        name: t.name || 'Unknown Track',
        artists: (t.artists && Array.isArray(t.artists)) ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist',
        album_art: imageUrl
      };
    });
  } catch (error) {
    // This will print the EXACT Spotify error to your backend terminal if it fails!
    console.error(`Spotify API Error (Playlist ${playlistId}):`, error.response?.data || error.message);
    throw error;
  }
}

async function getUserPlaylists() {
  const token = await getAccessToken();
  const response = await axios.get(`${SPOTIFY_API_BASE}/me/playlists`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.data.items.map(p => ({
    id: p.id,
    name: p.name,
    // Safely checks for tracks, and defaults to 0 if Spotify hides it!
    trackCount: p.tracks?.total || 0,
    image: p.images && p.images[0] ? p.images[0].url : null
  }));
}

async function transferPlayback(deviceId) {
  const token = await getAccessToken();
  await axios.put(`${SPOTIFY_API_BASE}/me/player`, { device_ids: [deviceId], play: true }, { headers: { 'Authorization': `Bearer ${token}` } });
  CACHE.devices.expires = 0;
  CACHE.nowPlaying.expires = 0;
}

module.exports = { searchTracks, getTrack, parseSpotifyUrl, getNowPlaying, addToQueue, getQueue, getAccessToken, clearTokenCache, playTrack, pausePlayback, resumePlayback, skipPlayback, getPlaylistTracks, getUserPlaylists, getDevices, transferPlayback };