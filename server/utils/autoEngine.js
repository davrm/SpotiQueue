const { getDb } = require('../db');
const spotify = require('./spotify');

let engineInterval = null;
let isEngineRunning = false;
let loadedTrackId = null;
let isTransitioning = false;

// CHANGED: Now takes the full track object instead of just the ID!
async function transitionTo(trackObj) {
    isTransitioning = true;
    loadedTrackId = trackObj.track_id;

    // THE FIX: Pre-shoot the cache! All screens will update instantly!
    spotify.overrideNowPlayingCache(trackObj);

    try {
        await spotify.playTrack(`spotify:track:${trackObj.track_id}`);
    } catch (e) {
        console.error("Engine failed to play track:", e.message);
    }

    setTimeout(() => { isTransitioning = false; }, 6000);
}

async function engineTick() {
    if (isTransitioning || !isEngineRunning) return;

    try {
        const db = getDb();
        const current = await spotify.getNowPlaying();
        const topTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();

        if (!current) {
            if (topTrack && !loadedTrackId) {
                await transitionTo(topTrack); // Pass full object!
            }
            return;
        }

        // External Skip Detection (Fixed to look inside current.item!)
        if (loadedTrackId && current.item && current.item.id && loadedTrackId !== current.item.id) {
            db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(loadedTrackId);
            loadedTrackId = current.item.id;
        }

        if (!loadedTrackId && current.item) {
            loadedTrackId = current.item.id;
        }

        const isPaused = !current.is_playing;
        const timeLeft = current.duration_ms - current.progress_ms;

        // The current song has naturally finished playing!
        if (!isPaused && timeLeft < 3000) {
            if (loadedTrackId) {
                db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(loadedTrackId);
            }

            const nextTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();
            if (nextTrack) {
                await transitionTo(nextTrack); // Pass full object!
            } else {
                loadedTrackId = null;
            }
        }

    } catch (error) {
        console.error("Engine tick error:", error);
        isTransitioning = false;
    }
}

module.exports = {
    startEngine: () => {
        if (!isEngineRunning) {
            isEngineRunning = true;
            isTransitioning = false;
            loadedTrackId = null;
            engineInterval = setInterval(engineTick, 2000);
        }
        return isEngineRunning;
    },
    stopEngine: () => {
        if (isEngineRunning) {
            isEngineRunning = false;
            clearInterval(engineInterval);
        }
        return isEngineRunning;
    },
    setLoadedTrack: (trackId) => {
        loadedTrackId = trackId;
        isTransitioning = true;
        setTimeout(() => { isTransitioning = false; }, 6000);
    },
    triggerManualSkip: async () => {
        isTransitioning = true;
        const db = getDb();

        if (loadedTrackId) {
            db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(loadedTrackId);
        }

        const nextTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();
        if (nextTrack) {
            await transitionTo(nextTrack); // Pass full object!
        } else {
            loadedTrackId = null;
            spotify.clearNowPlayingCache(); // Force refresh if queue is empty
            await spotify.skipToNext();
            setTimeout(() => { isTransitioning = false; }, 3000);
        }
    },
    getStatus: () => isEngineRunning,
    getLoadedTrackId: () => loadedTrackId
};