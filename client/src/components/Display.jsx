import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { QRCodeSVG } from 'qrcode.react'
import { ThumbsUp, WifiOff, Settings, Plus, Minus } from 'lucide-react'
import { useAuraColor } from '../hooks/useAuraColor'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'

const POLL_INTERVAL = 3000
const LINE_HEIGHT = 220

function computeLyricLineIndex(lines, currentMs) {
  if (!lines?.length) return 0
  const t = Math.max(0, currentMs)
  let idx = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (t >= (lines[i].startTimeMs ?? 0)) {
      idx = i
      break
    }
  }
  return idx
}

export default function Display() {
  const [nowPlaying, setNowPlaying] = useState(null)
  const [upNext, setUpNext] = useState([])
  const [connected, setConnected] = useState(true)
  const [progress, setProgress] = useState(0)
  const [initialized, setInitialized] = useState(false)
  const [queueUrl, setQueueUrl] = useState('')
  const [currentLyricIndex, setCurrentLyricIndex] = useState(0)
  const [cachedLyrics, setCachedLyrics] = useState(null)

  // Tunable Sync Offset
  const [lyricOffset, setLyricOffset] = useState(-250)

  const nowPlayingRef = useRef(null)
  const lastFetchedAtRef = useRef(null)
  const progressTimerRef = useRef(null)

  const auraColor = useAuraColor(nowPlaying?.album_art)
  const appUrl = queueUrl || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '')

  function getPlaybackMs() {
    const track = nowPlayingRef.current
    if (!track || !track.is_playing) return track?.progress_ms ?? 0
    return (track.progress_ms ?? 0) + (Date.now() - (lastFetchedAtRef.current || Date.now()))
  }

  useEffect(() => {
    const fetchDisplayData = async () => {
      try {
        const [npRes, qRes, configRes] = await Promise.all([
          axios.get('/api/now-playing'),
          axios.get('/api/queue/voting-list'),
          axios.get('/api/config/public')
        ])
        const track = npRes.data?.track ?? null
        if (track?.id !== nowPlayingRef.current?.id) setCachedLyrics(null)
        if (track && track.lyrics) setCachedLyrics(track.lyrics)
        else if (track && cachedLyrics) track.lyrics = cachedLyrics

        setNowPlaying(track)
        nowPlayingRef.current = track
        lastFetchedAtRef.current = Date.now()
        setUpNext(qRes.data || [])
        setQueueUrl(configRes.data?.queue_url || '')
        setConnected(true)
        setInitialized(true)
      } catch (e) {
        setConnected(false)
        setInitialized(true)
      }
    }
    fetchDisplayData()
    const interval = setInterval(fetchDisplayData, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [cachedLyrics])

  useEffect(() => {
    if (progressTimerRef.current) clearInterval(progressTimerRef.current)
    const tick = () => {
      const track = nowPlayingRef.current
      if (!track?.duration_ms) return
      const currentMs = getPlaybackMs()
      setProgress(Math.min((currentMs / track.duration_ms) * 100, 100))
      if (track.lyrics?.lines?.length) {
        setCurrentLyricIndex(computeLyricLineIndex(track.lyrics.lines, currentMs + lyricOffset))
      }
    }
    progressTimerRef.current = setInterval(tick, 100)
    return () => clearInterval(progressTimerRef.current)
  }, [nowPlaying, lyricOffset])

  const progressPercent = nowPlaying ? progress : 0

  return (
      <div className="fixed inset-0 bg-black text-white flex flex-col overflow-hidden select-none font-display uppercase tracking-tighter">

        {/* 1. TOP PROGRESS BAR */}
        <div className="absolute top-0 left-0 right-0 h-3 z-50 bg-white/10">
          <div
              className="h-full transition-all duration-300 ease-linear shadow-[0_0_25px_#1DB954]"
              style={{ width: `${progressPercent}%`, backgroundColor: '#1DB954' }}
          />
        </div>

        {/* 2. DYNAMIC BACKGROUND AURA */}
        {nowPlaying?.album_art && (
            <>
              <div
                  className="absolute inset-0 z-0 transition-all duration-[3000ms] opacity-50 blur-[200px] scale-150 animate-pulse-slow"
                  style={{ backgroundImage: `url(${nowPlaying.album_art})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              />
              <div className="absolute inset-0 z-1 bg-black/60" />
            </>
        )}

        {/* 3. GHOST SYNC CONTROL */}
        <div className="absolute bottom-6 left-6 z-50 flex items-center gap-3 bg-black/60 backdrop-blur-md border border-white/10 p-2 rounded-full opacity-0 hover:opacity-100 transition-opacity duration-500 group">
          <Settings className="w-4 h-4 text-white/50 ml-2 group-hover:animate-spin" />
          <div className="flex items-center gap-1 bg-white/10 rounded-full p-1">
            <button onClick={() => setLyricOffset(prev => prev - 50)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Minus className="w-4 h-4 text-white" />
            </button>
            <span className="w-16 text-center text-xs font-black font-mono text-white/80">{lyricOffset}ms</span>
            <button onClick={() => setLyricOffset(prev => prev + 50)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Plus className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        <div className="relative z-10 flex flex-col sm:flex-row flex-1 min-h-0 pt-3">

          {/* --- LEFT: MAIN FOCUS AREA --- */}
          <div className="flex-[2.4] flex flex-col p-10 min-h-0 overflow-hidden">
            {!initialized || !nowPlaying ? (
                <div className="flex-1 flex items-center justify-center text-white/20 font-black text-6xl">SYNCING...</div>
            ) : (
                <div className="w-full h-full flex flex-col gap-10">

                  {/* HERO HEADER */}
                  <div className="glass-panel p-8 rounded-[3.5rem] flex items-center gap-10 shrink-0">
                    <img src={nowPlaying.album_art} className="w-36 h-36 rounded-[2rem] object-cover shadow-2xl ring-2 ring-white/20" alt="" />
                    <div className="flex-1 min-w-0">
                      <h1 className="text-5xl sm:text-6xl font-black text-white line-clamp-2 leading-[1.1] drop-shadow-2xl">{nowPlaying.name}</h1>
                      <p className="text-2xl text-zinc-400 font-bold mt-2 tracking-[0.2em]">{nowPlaying.artists}</p>
                    </div>
                  </div>

                  {/* SMOOTH KINETIC LYRICS */}
                  <div className="flex-1 relative overflow-hidden mask-lyrics w-full">
                    {nowPlaying.lyrics?.lines ? (
                        <div className="absolute top-[35%] left-0 right-0 flex flex-col items-center pointer-events-none" style={{ marginTop: `-${LINE_HEIGHT / 2}px` }}>
                          <div
                              className="w-full flex flex-col items-center transition-transform duration-[1200ms]"
                              style={{
                                transform: `translateY(${-currentLyricIndex * LINE_HEIGHT}px)`,
                                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)'
                              }}
                          >
                            {nowPlaying.lyrics.lines.map((line, idx) => {
                              const isFocus = idx === currentLyricIndex;
                              const isPast = idx < currentLyricIndex;

                              return (
                                  <div
                                      key={idx}
                                      className={cn(
                                          "flex items-center justify-center text-center w-full px-10 transition-all duration-[1200ms] origin-center",
                                          isFocus ? "opacity-100 scale-100" : isPast ? "opacity-0 blur-2xl scale-[0.65]" : "opacity-30 blur-[2px] scale-[0.70]"
                                      )}
                                      style={{
                                        height: `${LINE_HEIGHT}px`,
                                        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)'
                                      }}
                                  >
                                    <p className={cn(
                                        "text-5xl sm:text-[6rem] leading-[1.1] font-black drop-shadow-[0_15px_40px_rgba(0,0,0,0.8)] transition-colors duration-[1200ms]",
                                        isFocus ? "text-white" : "text-white/70"
                                    )}>
                                      {line.words}
                                    </p>
                                  </div>
                              );
                            })}
                          </div>
                        </div>
                    ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-white/10 font-black text-5xl italic tracking-widest">Enjoy the Vibe</div>
                    )}
                  </div>
                </div>
            )}
          </div>

          {/* --- RIGHT: SIDEBAR (FRAMER MOTION ANIMATED) --- */}
          <div className="flex-1 flex flex-col overflow-hidden bg-black/70 backdrop-blur-3xl border-l border-white/10 rounded-l-[4rem]">
            <div className="flex-1 flex flex-col overflow-hidden p-10 pb-0">
              <div className="flex justify-between items-center mb-8 px-4">
                <h3 className="text-lg font-black tracking-[0.6em] text-white/30 italic">UP NEXT</h3>
                <span className="bg-white/10 px-3 py-1 rounded-full text-xs font-black text-white">{upNext.length} TRACKS</span>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 no-scrollbar">
                {upNext.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-white/5 font-black text-3xl italic tracking-widest">Waitlist Empty</div>
                ) : (
                    <div className="flex flex-col gap-4 relative pb-4">
                      <AnimatePresence mode="popLayout">
                        {upNext.slice(0, 10).map((track, i) => (
                            <motion.div
                                layout
                                initial={{ opacity: 0, scale: 0.9, x: 20 }}
                                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                                exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.2 } }}
                                transition={{ type: "spring", stiffness: 350, damping: 25, mass: 1 }}
                                key={track.track_id}
                                className="flex items-center gap-5 p-4 rounded-[2.5rem] bg-white/[0.03] border border-white/5 shadow-lg"
                            >
                              <span className="text-white/10 font-black text-2xl italic w-8 text-center shrink-0">{i + 1}</span>
                              <img src={track.album_art} className="w-14 h-14 rounded-2xl object-cover grayscale opacity-40 shrink-0" alt="" />
                              <div className="flex-1 min-w-0">
                                <p className="font-black text-base text-white truncate leading-none mb-1.5">{track.track_name}</p>
                                <p className="text-zinc-600 text-[10px] font-black tracking-widest truncate uppercase">{track.artist_name}</p>
                              </div>
                              <div className="bg-white/5 px-4 py-2.5 rounded-2xl flex items-center gap-2 border border-white/5 shrink-0">
                                <span className="text-white/70 font-black text-lg">{track.votes}</span>
                                <ThumbsUp className="h-4 w-4 text-white/30" />
                              </div>
                            </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                )}
              </div>
            </div>

            {/* QR SECTION */}
            {appUrl && (
                <div className="shrink-0 p-10 bg-black/40 border-t border-white/10">
                  <div className="flex items-center gap-8">
                    <div className="w-32 h-32 bg-white p-3 shrink-0 shadow-2xl ring-4 ring-white/5 rounded-3xl">
                      <QRCodeSVG value={appUrl} width="100%" height="100%" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-black text-4xl text-white italic tracking-tighter leading-none">JOIN PARTY</h4>
                      <p className="text-zinc-500 font-black text-[11px] tracking-[0.2em] mt-3 truncate uppercase">{appUrl}</p>
                    </div>
                  </div>
                </div>
            )}
          </div>
        </div>
      </div>
  )
}