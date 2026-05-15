const { getDb } = require('../db');
const { getNowPlaying, playTrack } = require('./spotify');

let engineInterval = null;
let isEngineRunning = false;
let isTransitioning = false;
let lastSeenTrackId = null;

async function engineTick() {
    if (isTransitioning) return;

    try {
        const db = getDb();
        const current = await getNowPlaying();

        if (!current) return;

        const currentTrackId = current.id;
        const isPaused = !current.is_playing;
        const timeLeft = current.duration_ms - current.progress_ms;

        let needsNextSong = false;

        // SCENARIO: Manual skip detection or end of song
        if (lastSeenTrackId !== null && lastSeenTrackId !== currentTrackId) {
            needsNextSong = true;
        } else if (!isPaused && timeLeft < 3000) {
            needsNextSong = true;
        }

        if (needsNextSong) {
            const stmt = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1');
            const topTrack = stmt.get();

            if (topTrack) {
                isTransitioning = true;
                await playTrack(`spotify:track:${topTrack.track_id}`);
                db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(topTrack.track_id);
                lastSeenTrackId = topTrack.track_id;
                // Wait 5 seconds before checking again to prevent double-skipping
                setTimeout(() => { isTransitioning = false; }, 5000);
            } else {
                lastSeenTrackId = currentTrackId;
            }
        } else {
            lastSeenTrackId = currentTrackId;
        }
    } catch (error) {
        isTransitioning = false;
    }
}

module.exports = {
    startEngine: () => {
        if (!isEngineRunning) {
            isEngineRunning = true;
            lastSeenTrackId = null;
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
    triggerManualSkip: () => {
        isTransitioning = false; // Force unlock
        lastSeenTrackId = "FORCE_SKIP"; // Trigger the change detection
    },
    forceNext: async () => {
        const db = getDb();
        const stmt = db.prepare('SELECT * FROM local_queue ORDER BY votes DESC, added_at ASC LIMIT 1');
        const topTrack = stmt.get();

        if (topTrack) {
            // Use the playTrack function we added earlier
            const { playTrack } = require('./spotify');
            await playTrack(`spotify:track:${topTrack.track_id}`);
            db.prepare('DELETE FROM local_queue WHERE track_id = ?').run(topTrack.track_id);
            return { success: true, track: topTrack.track_name };
        }
        return { success: false, error: "Queue is empty" };
    },
    getStatus: () => isEngineRunning
};