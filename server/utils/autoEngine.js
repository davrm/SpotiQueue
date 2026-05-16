const { getDb } = require('../db');
const spotify = require('./spotify');

let engineInterval = null;
let isEngineRunning = false;
let loadedTrackId = null; // Memory of what is playing so we don't delete it early
let isTransitioning = false;

async function transitionTo(trackId) {
    isTransitioning = true;
    loadedTrackId = trackId; // LOCK IN THE TRACK!

    try {
        await spotify.playTrack(`spotify:track:${trackId}`);
    } catch (e) {
        console.error("Engine failed to play track:", e.message);
    }

    // Lock the engine for 6 seconds so Spotify's API has time to update
    setTimeout(() => { isTransitioning = false; }, 6000);
}

async function engineTick() {
    if (isTransitioning || !isEngineRunning) return;

    try {
        const db = getDb();
        const current = await spotify.getNowPlaying();
        const topTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();

        // Scenario 1: Nothing is playing on Spotify, but we have a queue
        if (!current) {
            // THE FIX: Only auto-start if we haven't loaded a track yet!
            // If loadedTrackId is set, Spotify is probably just buffering or paused.
            // DO NOT override it with a new upvoted track!
            if (topTrack && !loadedTrackId) {
                await transitionTo(topTrack.track_id);
            }
            return;
        }

        // Scenario 1.5: External Skip Detection
        // If someone skipped the song using the Spotify App on their phone:
        if (loadedTrackId && current.id && loadedTrackId !== current.id) {
            // The song changed externally! Remove the old one from the waitlist.
            db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(loadedTrackId);
            loadedTrackId = current.id; // Lock onto the new song
        }

        // If we don't have a loaded track in memory but music is playing, lock it in so we don't interrupt it.
        if (!loadedTrackId) {
            loadedTrackId = current.id;
        }

        const isPaused = !current.is_playing;
        const timeLeft = current.duration_ms - current.progress_ms;

        // Scenario 2: The current song has naturally finished playing!
        if (!isPaused && timeLeft < 3000) {
            // 1. Safely remove the finished song from the database NOW
            if (loadedTrackId) {
                db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(loadedTrackId);
            }

            // 2. Fetch the NEW top track and play it
            const nextTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();
            if (nextTrack) {
                await transitionTo(nextTrack.track_id);
            } else {
                loadedTrackId = null; // Queue is empty
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
            // Clear memory when starting fresh so we resync with Spotify
            loadedTrackId = null;
            engineInterval = setInterval(engineTick, 2000);
            console.log("🚀 CrowdPlay Auto-Engine Started!");
        }
        return isEngineRunning;
    },
    stopEngine: () => {
        if (isEngineRunning) {
            isEngineRunning = false;
            clearInterval(engineInterval);
            console.log("🛑 CrowdPlay Auto-Engine Stopped.");
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

        // Delete the currently loaded track because we are explicitly skipping it!
        if (loadedTrackId) {
            db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(loadedTrackId);
        }

        const nextTrack = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1').get();
        if (nextTrack) {
            await transitionTo(nextTrack.track_id);
        } else {
            loadedTrackId = null;
            await spotify.skipToNext();
            setTimeout(() => { isTransitioning = false; }, 3000);
        }
    },
    getStatus: () => isEngineRunning
};