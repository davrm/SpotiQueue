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

// --- API Request Tracker ---
const apiRequests = [];

axios.interceptors.request.use(config => {
  if (config.url && config.url.includes('spotify.com')) {
    const now = Date.now();
    apiRequests.push(now);
    // Cleanup items older than 60 seconds to track live RPM
    while (apiRequests.length > 0 && apiRequests[0] < now - 60000) {
      apiRequests.shift();
    }
  }
  return config;
});

function getApiStats() {
  const now = Date.now();
  // Filter one more time to be perfectly accurate
  const validRequests = apiRequests.filter(time => time >= now - 60000);
  apiRequests.length = 0;
  apiRequests.push(...validRequests);

  const rpm = apiRequests.length;
  let status = 'SAFE';
  if (rpm >= 45) status = 'DANGER';
  else if (rpm >= 25) status = 'WARNING';

  // Check if we are currently locked by a penalty
  const locked = Math.max(CACHE.nowPlaying.expires, CACHE.devices.expires, CACHE.queue.expires) > now;

  return { rpm, status: locked ? 'LOCKED' : status, locked };
}

function clearTokenCache() {
  accessToken = null;
  tokenExpiresAt = 0;
}

// Spotify API base URL
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

// Handle Rate Limits Globally and read Spotify's required wait time
function handleRateLimit(error, cacheKey, defaultWaitMs = 15000) {
  if (error.response?.status === 429) {
    const retryAfterSeconds = parseInt(error.response.headers['retry-after'], 10);
    const penaltyMs = (retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : defaultWaitMs) + 1000;

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

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Spotify credentials in environment');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refreshToken);

  const response = await axios.post('https://accounts.spotify.com/api/token', params, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  accessToken = response.data.access_token;
  tokenExpiresAt = now + response.data.expires_in;
  return accessToken;
}

// --- SAFE CACHED API CALLS ---
async function getNowPlaying() {
  const now = Date.now();

  // LOCKDOWN MODE: Serve cached data, but simulate the time moving forward locally!
  if (CACHE.nowPlaying.expires > now) {
    const cached = CACHE.nowPlaying.data;
    if (cached && cached.is_playing) {
      // Calculate exactly how many milliseconds have passed since we last asked Spotify
      const timeElapsed = now - CACHE.nowPlaying.fetchedAt;

      // Return a perfectly updated, extrapolated progress_ms!
      return {
        ...cached,
        progress_ms: cached.progress_ms + timeElapsed
      };
    }
    return cached;
  }

  if (CACHE.nowPlaying.promise) return CACHE.nowPlaying.promise;

  CACHE.nowPlaying.promise = (async () => {
    try {
      const token = await getAccessToken();
      const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/currently-playing`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.status === 204 || !response.data) {
        CACHE.nowPlaying.data = null;
      } else {
        const item = response.data.item;
        CACHE.nowPlaying.data = {
          is_playing: response.data.is_playing,
          progress_ms: response.data.progress_ms,
          duration_ms: item ? item.duration_ms : 0,
          item: item ? {
            id: item.id,
            name: item.name,
            artists: item.artists.map(a => a.name).join(', '),
            album_art: item.album?.images[0]?.url || null,
            uri: item.uri
          } : null
        };
        // ADDED: Save the exact timestamp we got this data for the math above
        CACHE.nowPlaying.fetchedAt = Date.now();
      }

      CACHE.nowPlaying.expires = Date.now() + 10000; // Safe 10s cooldown
      return CACHE.nowPlaying.data;
    } catch (error) {
      handleRateLimit(error, 'nowPlaying');
      return CACHE.nowPlaying.data;
    } finally {
      CACHE.nowPlaying.promise = null;
    }
  })();

  return CACHE.nowPlaying.promise;
}

async function getDevices(forceRefresh = false) {
  const now = Date.now();
  // LOCKDOWN MODE: Return device hardware cache directly unless manually prompted
  if (!forceRefresh) {
    if (CACHE.devices.expires > now) return CACHE.devices.data;
    if (CACHE.devices.promise) return CACHE.devices.promise;
  }

  CACHE.devices.promise = (async () => {
    try {
      const token = await getAccessToken();
      const response = await axios.get(`${SPOTIFY_API_BASE}/me/player/devices`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      CACHE.devices.data = response.data.devices || [];
      CACHE.devices.expires = Date.now() + 120000; // Strong 2-minute default hardware cache
      return response.data.devices || [];
    } catch (error) {
      console.error("Backend Error fetching devices:", error.response?.data || error.message);
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
  const response = await axios.get(`${SPOTIFY_API_BASE}/search`, {
    params: { q: query, type: 'track', limit },
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return (response.data.tracks?.items || []).map(track => ({
    id: track.id,
    name: track.name,
    artists: track.artists.map(a => a.name).join(', '),
    album: track.album.name,
    album_art: track.album.images[0]?.url || null,
    explicit: track.explicit,
    duration_ms: track.duration_ms,
    uri: track.uri
  }));
}

async function getTrack(trackId) {
  const token = await getAccessToken();
  const response = await axios.get(`${SPOTIFY_API_BASE}/tracks/${trackId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const track = response.data;
  return {
    id: track.id,
    name: track.name,
    artists: track.artists.map(a => a.name).join(', '),
    album_art: track.album.images[0]?.url || null,
    uri: track.uri
  };
}

async function getUserPlaylists() {
  const token = await getAccessToken();
  const response = await axios.get(`${SPOTIFY_API_BASE}/me/playlists`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return (response.data.items || []).map(p => ({
    id: p.id,
    name: p.name,
    image: p.images?.[0]?.url || null,
    tracks_count: p.tracks?.total || 0
  }));
}

async function getPlaylistTracks(playlistId) {
  try {
    const token = await getAccessToken();
    const response = await axios.get(`${SPOTIFY_API_BASE}/playlists/${playlistId}/items`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.data || !response.data.items) return [];

    const validItems = response.data.items.filter(wrapper => {
      const t = wrapper.item || wrapper.track;
      return t && t.id && t.type === 'track';
    });

    return validItems.map(wrapper => {
      const t = wrapper.item || wrapper.track;
      let imageUrl = null;
      if (t.album?.images?.length > 0) {
        imageUrl = t.album.images[0].url;
      }

      return {
        id: t.id,
        name: t.name || 'Unknown Track',
        artists: Array.isArray(t.artists) ? t.artists.map(a => a.name).join(', ') : 'Unknown Artist',
        album_art: imageUrl,
        uri: t.uri
      };
    });
  } catch (error) {
    console.error(`Spotify API Error (Playlist ${playlistId}):`, error.response?.data || error.message);
    throw error;
  }
}

async function removeTrackFromPlaylist(playlistId, trackUri) {
  const token = await getAccessToken();
  await axios.delete(`${SPOTIFY_API_BASE}/playlists/${playlistId}/items`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    data: {
      tracks: [{ uri: trackUri }]
    }
  });
}

// --- CONTROLS ---
async function transferPlayback(deviceId) {
  const token = await getAccessToken();
  await axios.put(`${SPOTIFY_API_BASE}/me/player`,
      // CHANGE: Set play to false so the speaker wakes up silently
      { device_ids: [deviceId], play: false },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  CACHE.devices.expires = 0;
  CACHE.nowPlaying.expires = 0;
}

function overrideNowPlayingCache(trackData) {
  CACHE.nowPlaying.data = {
    is_playing: true,
    progress_ms: 0,
    // We guess the length (3m20s). The true sync will overwrite this seamlessly in 8 seconds!
    duration_ms: trackData.duration_ms || 200000,
    item: {
      id: trackData.track_id || trackData.id,
      name: trackData.track_name || trackData.name,
      artists: trackData.artist_name || trackData.artists,
      album_art: trackData.album_art
    }
  };
  CACHE.nowPlaying.fetchedAt = Date.now();
  // Lock the cache for 8 seconds to completely ignore Spotify's native API lag!
  CACHE.nowPlaying.expires = Date.now() + 8000;
}

function clearNowPlayingCache() {
  CACHE.nowPlaying.expires = 0;
}

// BUGFIX: Removed the cache clear from playTrack so our override survives!
async function playTrack(track_uri, device_id = null) {
  const token = await getAccessToken();
  const config = {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };

  if (device_id) config.params = { device_id };

  await axios.put(`${SPOTIFY_API_BASE}/me/player/play`, { uris: [track_uri] }, config);
  // Do NOT clear the cache here anymore!
}

async function pausePlayback() {
  const token = await getAccessToken();
  await axios.put(`${SPOTIFY_API_BASE}/me/player/pause`, null, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (CACHE.nowPlaying.data && CACHE.nowPlaying.data.is_playing) {
    // Instantly stop the extrapolator from adding any more time!
    CACHE.nowPlaying.data.is_playing = false;
    const timeElapsed = Date.now() - CACHE.nowPlaying.fetchedAt;
    CACHE.nowPlaying.data.progress_ms += timeElapsed;
  }
  CACHE.nowPlaying.expires = 0;
}

async function resumePlayback() {
  const token = await getAccessToken();
  await axios.put(`${SPOTIFY_API_BASE}/me/player/play`, null, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (CACHE.nowPlaying.data) {
    // Restart the extrapolator clock!
    CACHE.nowPlaying.data.is_playing = true;
    CACHE.nowPlaying.fetchedAt = Date.now();
  }
  CACHE.nowPlaying.expires = 0;
}

async function skipToNext() {
  const token = await getAccessToken();
  await axios.post(`${SPOTIFY_API_BASE}/me/player/next`, null, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  // Force the cache to clear instantly!
  CACHE.nowPlaying.expires = 0;
}

module.exports = {
  clearTokenCache,
  getNowPlaying,
  getDevices,
  searchTracks,
  getTrack,
  getUserPlaylists,
  getPlaylistTracks,
  removeTrackFromPlaylist,
  transferPlayback,
  playTrack,
  pausePlayback,
  resumePlayback,
  skipToNext,
  getApiStats,
  overrideNowPlayingCache,
  clearNowPlayingCache
};