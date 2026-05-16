import { useState, useEffect, useRef } from 'react'
import axios from '@/lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
    ThumbsUp, ThumbsDown, Trash2, Play, Square, SkipForward,
    Pause, Plus, Search, Library, ChevronLeft, ListMusic, Speaker, Clock
} from 'lucide-react'

function LiveQueue() {
    const [queue, setQueue] = useState([])
    const [engineActive, setEngineActive] = useState(false)
    const [nowPlaying, setNowPlaying] = useState(null)
    const [devices, setDevices] = useState([])
    const [loading, setLoading] = useState(true)

    // Search & Library States
    const [searchMode, setSearchMode] = useState('search')
    const [query, setQuery] = useState('')
    const [results, setResults] = useState([])
    const [playlists, setPlaylists] = useState([])
    const [selectedPlaylist, setSelectedPlaylist] = useState(null)
    const [isAddingAll, setIsAddingAll] = useState(false)

    // Smooth Progress Bar Logic
    const [localProgress, setLocalProgress] = useState(0)
    const progressTimer = useRef(null)

    // --- 1. SYNC DATA (Safe Lockdown mode, polling interval adjusted to 6s) ---
    const fetchData = async () => {
        try {
            // Only ask for the Queue and the Engine Status first
            const [qRes, eRes] = await Promise.all([
                axios.get('/api/queue/voting-list'),
                axios.get('/api/admin/engine-status')
            ])

            setQueue(qRes.data)
            const isEngineRunning = eRes.data.active;
            setEngineActive(isEngineRunning)

            // KILLSWITCH: Only poll Spotify for Now Playing if the engine is actually ON!
            if (isEngineRunning) {
                const nRes = await axios.get('/api/admin/now-playing');
                const np = nRes.data;
                setNowPlaying(np.item ? np : null);
                if (np.item) setLocalProgress(np.progress_ms);
            } else {
                // If the party is stopped, wipe the current track from the screen instantly
                setNowPlaying(null);
                setLocalProgress(0);
            }

        } catch (e) {
            console.error("Mission Control Sync Error:", e)
        } finally {
            setLoading(false)
        }
    }

    // Manual on-demand fetch for audio hardware
    const refreshDevices = async (force = false) => {
        try {
            const dRes = await axios.get(`/api/admin/spotify/devices${force ? '?refresh=true' : ''}`);
            setDevices(dRes.data || []);
        } catch (err) {
            console.error("Failed to load hardware targets:", err);
        }
    }

    useEffect(() => {
        fetchData();
        refreshDevices(false); // Fetch silently on load

        // Extended safety layout running every 6000ms instead of 3500ms
        const dataInterval = setInterval(fetchData, 6000)

        // Smooth progress incrementer (runs locally every 1s)
        progressTimer.current = setInterval(() => {
            setNowPlaying(prev => {
                if (prev && prev.is_playing) {
                    setLocalProgress(old => Math.min(old + 1000, prev.duration_ms))
                }
                return prev
            })
        }, 1000)

        return () => {
            clearInterval(dataInterval)
            clearInterval(progressTimer.current)
        }
    }, [])

    // --- 2. HELPERS ---
    const formatTime = (ms) => {
        const mins = Math.floor(ms / 60000)
        const secs = ((ms % 60000) / 1000).toFixed(0)
        return `${mins}:${secs.padStart(2, '0')}`
    }

    // --- 3. PARTY & PLAYBACK ACTIONS ---
    const handleDeviceChange = async (e) => {
        const val = e.target.value

        if (val === "STOP") {
            // OPTIMISTIC UPDATE: Instantly shut down the UI
            setEngineActive(false);
            setNowPlaying(null);
            await axios.post('/api/admin/stop-party');
        }
        else if (val !== "") {
            // OPTIMISTIC UPDATE: Instantly lock the dropdown and start the engine UI
            setEngineActive(true);
            setDevices(prev => prev.map(d => ({ ...d, is_active: d.id === val })));

            try {
                await axios.post('/api/admin/start-party', { deviceId: val });
            } catch (err) {
                // If it fails to wake up the speaker, revert the UI back
                setEngineActive(false);
                alert("Could not wake up device. Is Spotify open on it?");
            }
        }

        fetchData();
    }

    const handleTogglePlay = async () => {
        if (!nowPlaying) return;

        // OPTIMISTIC UPDATE: Instantly flip the play/pause icon locally!
        const wasPlaying = nowPlaying.is_playing;
        setNowPlaying(prev => ({ ...prev, is_playing: !wasPlaying }));

        try {
            await axios.post('/api/admin/playback/toggle');
            fetchData(); // Sync the real data silently in the background
        } catch (e) {
            // If Spotify throws an error, revert the icon back to its true state
            setNowPlaying(prev => ({ ...prev, is_playing: wasPlaying }));
            alert(e.response?.data?.error || "Playback control failed");
        }
    }
    const handleNext = () => axios.post('/api/admin/playback/next').then(fetchData)
    const handleVote = (trackId, delta) => axios.post(`/api/admin/queue/${trackId}/vote`, { delta }).then(fetchData)
    const handleRemove = (trackId) => window.confirm('Remove from queue?') && axios.delete(`/api/admin/queue/${trackId}`).then(fetchData)

    const handleClearQueue = async () => {
        if (!window.confirm('Are you sure you want to permanently clear the entire waitlist? This cannot be undone!')) return;
        try {
            await axios.delete('/api/admin/queue-clear');
            fetchData();
        } catch (e) {
            alert('Failed to clear the queue.');
        }
    }

    // --- 4. SEARCH & LIBRARY ACTIONS ---
    const handleSearch = async () => {
        if (!query) return
        const res = await axios.post('/api/queue/search', { query })
        setResults(res.data.tracks)
    }

    const loadPlaylists = async () => {
        setSearchMode('library')
        setSelectedPlaylist(null)
        setResults([])
        const res = await axios.get('/api/admin/playlists')
        setPlaylists(res.data)
    }

    const loadPlaylistTracks = async (playlist) => {
        const res = await axios.get(`/api/admin/playlists/${playlist.id}/tracks`)
        setResults(res.data)
        setSelectedPlaylist(playlist)
    }

    const handleAddAll = async () => {
        if (!selectedPlaylist) return
        setIsAddingAll(true)
        try {
            await axios.post(`/api/admin/queue/add-playlist/${selectedPlaylist.id}`)
            fetchData()
            setSelectedPlaylist(null)
            setResults([])
        } catch (e) {
            alert('Failed to add all tracks.')
        } finally {
            setIsAddingAll(false)
        }
    }

    const addToLocalQueue = async (track) => {
        try {
            await axios.post('/api/admin/queue/add', { track_id: track.id })
            fetchData()
        } catch (e) {
            alert('Failed to add track to queue.')
        }
    }

    const handleRemoveFromPlaylist = async (track) => {
        if (!selectedPlaylist) return;
        if (!window.confirm(`Are you sure you want to permanently delete "${track.name}" from your Spotify playlist?`)) return;

        try {
            await axios.delete(`/api/admin/playlists/${selectedPlaylist.id}/tracks`, {
                data: { uri: track.uri }
            });
            loadPlaylistTracks(selectedPlaylist);
        } catch (e) {
            alert('Failed to delete track. Ensure you granted modify permissions!');
        }
    }

    if (loading) return <div className="text-center py-20 text-muted-foreground animate-pulse">Initializing CrowdPlay Control...</div>

    const activeDevice = devices.find(d => d.is_active)
    const progressPercent = nowPlaying ? (localProgress / nowPlaying.duration_ms) * 100 : 0
    const visibleQueue = nowPlaying ? queue.filter(track => track.track_id !== nowPlaying.item.id) : queue;

    return (
        <div className="space-y-6 max-w-5xl mx-auto pb-[450px] px-2">

            {/* --- MONITOR: NOW PLAYING --- */}
            {nowPlaying ? (
                <Card className="bg-zinc-950 text-white border-none shadow-2xl overflow-hidden ring-1 ring-white/10">
                    <CardContent className="p-0">
                        <div className="flex flex-col sm:flex-row">
                            <img src={nowPlaying.item.album_art} className="w-full sm:w-32 sm:h-32 object-cover" alt="" />
                            <div className="p-4 flex-1 flex flex-col justify-center min-w-0">
                                <div className="flex justify-between items-start">
                                    <div className="min-w-0">
                                        <h2 className="text-lg font-bold truncate leading-tight">{nowPlaying.item.name}</h2>
                                        <p className="text-zinc-400 text-sm truncate">{nowPlaying.item.artists}</p>
                                    </div>
                                    <div className="bg-green-500/10 text-green-400 text-[9px] font-black px-2 py-1 rounded border border-green-500/20 uppercase tracking-widest">
                                        Live
                                    </div>
                                </div>
                                <div className="mt-4 space-y-1">
                                    <div className="h-1.5 w-full bg-zinc-800 rounded-full">
                                        <div
                                            className="h-full bg-green-500 transition-all duration-1000 ease-linear"
                                            style={{ width: `${progressPercent}%` }}
                                        />
                                    </div>
                                    <div className="flex justify-between text-[10px] font-mono text-zinc-500">
                                        <span>{formatTime(localProgress)}</span>
                                        <span>{formatTime(nowPlaying.duration_ms)}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <Card className="border-dashed border-2 bg-muted/10 py-8 text-center text-muted-foreground text-xs italic">
                    Select a device below to start the party.
                </Card>
            )}

            {/* --- CONTROLS: ENGINE & PLAYBACK --- */}
            <Card className={engineActive ? 'border-green-500/50 shadow-lg ring-1 ring-green-500/10' : ''}>
                <CardContent className="pt-6 space-y-5">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between px-0.5">
                            <label className="text-[10px] font-black uppercase tracking-[0.15em] text-muted-foreground">Output Device & Engine</label>
                            {engineActive && <span className="text-[10px] font-bold text-green-500 animate-pulse flex items-center gap-1">● CROWDPLAY ACTIVE</span>}
                        </div>

                        <div className="relative">
                            <select
                                onFocus={() => refreshDevices(true)} // Fetches hardware dynamically only on input focus context
                                onChange={handleDeviceChange}
                                value={engineActive ? (activeDevice?.id || "") : "STOP"}
                                className="w-full h-12 pl-10 pr-4 bg-background border-2 rounded-xl text-sm font-bold appearance-none focus:ring-2 focus:ring-primary outline-none"
                            >
                                <option value="STOP">🔴 STOP PARTY / ENGINE OFF</option>
                                <optgroup label="Select Device to Start Party">
                                    {devices.map(d => (
                                        <option key={d.id} value={d.id}>
                                            {d.is_active ? '🟢' : '⚪'} {d.name} {d.id === activeDevice?.id ? '(Connected)' : ''}
                                        </option>
                                    ))}
                                </optgroup>
                            </select>
                            <Speaker className="absolute left-3 top-3.5 h-5 w-5 text-muted-foreground pointer-events-none" />
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <Button variant="outline" className="flex-1 h-14 border-2" onClick={handleTogglePlay}>
                            {nowPlaying?.is_playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
                        </Button>
                        <Button variant="outline" className="flex-1 h-14 border-2" onClick={handleNext}>
                            <SkipForward className="h-6 w-6" />
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* --- LIST: VOTING QUEUE --- */}
            <div className="space-y-3">
                <div className="flex items-center justify-between px-1">
                    <h3 className="font-black text-[10px] uppercase tracking-widest text-muted-foreground">Upcoming Votes ({visibleQueue.length})</h3>
                    {visibleQueue.length > 0 && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleClearQueue}
                            className="h-6 px-2 text-[10px] font-bold text-red-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                            CLEAR ALL
                        </Button>
                    )}
                </div>

                {visibleQueue.length === 0 ? (
                    <div className="py-12 text-center border-2 border-dashed rounded-2xl text-muted-foreground text-sm">Waitlist is currently empty.</div>
                ) : (
                    visibleQueue.map((track, i) => (
                        <Card key={track.track_id} className="p-2 border-none shadow-sm hover:shadow-md transition-shadow">
                            <div className="flex items-center gap-3">
                                <span className="text-[10px] font-mono text-muted-foreground w-4">{i + 1}</span>
                                <img src={track.album_art} className="w-10 h-10 rounded shadow-sm object-cover" alt="" />
                                <div className="flex-1 min-w-0">
                                    <div className="font-bold truncate text-sm leading-tight">{track.track_name}</div>
                                    <div className="text-[11px] text-muted-foreground truncate">{track.artist_name}</div>
                                </div>
                                <div className="flex items-center gap-0.5">
                                    <Button variant="ghost" size="sm" onClick={() => handleVote(track.track_id, -1)} className="h-8 w-8 p-0 hover:text-red-500 hover:bg-red-500/10 transition-colors">
                                        <ThumbsDown className="h-4 w-4" />
                                    </Button>

                                    <span className="text-xs font-black w-6 text-center">{track.votes}</span>

                                    <Button variant="ghost" size="sm" onClick={() => handleVote(track.track_id, 1)} className="h-8 w-8 p-0 hover:text-green-500 hover:bg-green-500/10 transition-colors">
                                        <ThumbsUp className="h-4 w-4" />
                                    </Button>

                                    <div className="w-px h-6 bg-border mx-1" />

                                    <Button variant="ghost" size="sm" onClick={() => handleRemove(track.track_id)} className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        </Card>
                    ))
                )}
            </div>

            {/* --- PANEL: FLOATING ADD TOOL --- */}
            <div className="fixed bottom-0 left-0 right-0 md:left-48 bg-background/95 backdrop-blur-md border-t shadow-[0_-10px_40px_rgba(0,0,0,0.15)] z-20">
                <div className="max-w-4xl mx-auto p-4 space-y-4">

                    <div className="flex gap-2 justify-center">
                        <Button variant={searchMode === 'search' ? 'default' : 'outline'} size="sm" onClick={() => { setSearchMode('search'); setResults([]); setSelectedPlaylist(null); }}>
                            <Search className="h-4 w-4 mr-2" /> Search
                        </Button>
                        <Button variant={searchMode === 'library' ? 'default' : 'outline'} size="sm" onClick={loadPlaylists}>
                            <Library className="h-4 w-4 mr-2" /> Playlists
                        </Button>
                    </div>

                    <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                        {searchMode === 'search' && (
                            <div className="flex gap-2 sticky top-0 bg-background/50 pb-2 z-10">
                                <Input
                                    placeholder="Find songs..."
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                                    className="h-11 rounded-xl"
                                />
                                <Button onClick={handleSearch} className="h-11 px-5 rounded-xl"><Search className="h-4 w-4" /></Button>
                            </div>
                        )}

                        {searchMode === 'library' && !selectedPlaylist && (
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                                {playlists.map(p => (
                                    <Button key={p.id} variant="outline" className="justify-start h-14 p-1 rounded-xl" onClick={() => loadPlaylistTracks(p)}>
                                        <img src={p.image} className="w-12 h-12 mr-2 rounded-lg object-cover" alt="" />
                                        <span className="truncate text-[10px] font-bold text-left uppercase">{p.name}</span>
                                    </Button>
                                ))}
                            </div>
                        )}

                        {selectedPlaylist && (
                            <div className="flex items-center justify-between bg-primary/5 p-2 rounded-xl mb-2 sticky top-0 z-10 border border-primary/10">
                                <Button variant="ghost" size="sm" onClick={() => { setSelectedPlaylist(null); setResults([]); }}>
                                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                                </Button>
                                <div className="text-[10px] font-black truncate px-2 text-primary uppercase">{selectedPlaylist.name}</div>
                                <Button
                                    size="sm"
                                    className="bg-green-600 hover:bg-green-700 text-white font-bold h-8"
                                    onClick={handleAddAll}
                                    disabled={isAddingAll}
                                >
                                    <ListMusic className="h-3 w-3 mr-2" /> {isAddingAll ? 'Adding...' : 'Add All'}
                                </Button>
                            </div>
                        )}

                        {results.map(track => (
                            <div key={track.id} className="flex items-center justify-between p-2 rounded-xl hover:bg-accent border border-transparent hover:border-border transition-all">
                                <div className="flex items-center gap-3 min-w-0">
                                    <img src={track.album_art} className="w-10 h-10 rounded-lg shadow-sm" alt="" />
                                    <div className="truncate min-w-0">
                                        <div className="font-bold text-sm truncate">{track.name}</div>
                                        <div className="text-[10px] text-muted-foreground truncate uppercase">{track.artists}</div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-1">
                                    {selectedPlaylist && (
                                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 rounded-full hover:bg-red-500/10 hover:text-red-500 text-muted-foreground" onClick={() => handleRemoveFromPlaylist(track)}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    )}
                                    <Button size="sm" variant="secondary" className="h-8 w-8 p-0 rounded-full" onClick={() => addToLocalQueue(track)}>
                                        <Plus className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}

export default LiveQueue