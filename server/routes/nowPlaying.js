const express = require('express');
const { getNowPlaying, getQueue } = require('../utils/spotify');
const { getLyrics } = require('../utils/lyrics');

const router = express.Router();
const lyricsCache = new Map();
const lyricsFailureCache = new Map();
const LYRICS_RETRY_AFTER_MS = 5 * 60 * 1000; // Don't retry failed tracks for 5 minutes

function ensureLyricsFetch(track, cacheKey) {
  if (!track || !cacheKey) return;
  if (lyricsCache.has(cacheKey)) return;
  const failedAt = lyricsFailureCache.get(cacheKey);
  if (failedAt && Date.now() - failedAt < LYRICS_RETRY_AFTER_MS) return;

  getLyrics(track.name, track.artists, track.id)
    .then(lyrics => {
      if (lyrics) {
        lyricsCache.set(cacheKey, lyrics);
        lyricsFailureCache.delete(cacheKey);
      } else {
        lyricsFailureCache.set(cacheKey, Date.now());
      }
    })
    .catch(() => {
      lyricsFailureCache.set(cacheKey, Date.now());
    });
}

router.get('/', async (req, res) => {
  try {
    const current = await getNowPlaying();

    // Ensure we have a valid song object with an item inside
    if (current && current.item) {
      const trackItem = current.item;
      const cacheKey = trackItem.id;

      if (lyricsCache.has(cacheKey)) {
        current.lyrics = lyricsCache.get(cacheKey);
      } else {
        ensureLyricsFetch(trackItem, cacheKey);
      }

      // Pre-fetch lyrics for the next song(s) in queue
      try {
        const { queue } = await getQueue();
        if (queue?.length > 0) {
          for (let i = 0; i < Math.min(queue.length, 2); i++) {
            const next = queue[i];
            ensureLyricsFetch(next, next.track_id || next.id);
          }
        }
      } catch {
        // Non-critical; continue
      }

      // THE FIX: "Flatten" the object so the older frontend screens can read it!
      const flatTrack = {
        is_playing: current.is_playing,
        progress_ms: current.progress_ms,
        duration_ms: current.duration_ms,
        id: trackItem.id,
        name: trackItem.name,
        artists: trackItem.artists,
        album_art: trackItem.album_art,
        lyrics: current.lyrics
      };

      return res.json({ track: flatTrack });
    }

    // If nothing is playing, return null
    res.json({ track: null });
  } catch (error) {
    console.error('Now playing error:', error);
    res.json({ track: null });
  }
});

module.exports = router;

