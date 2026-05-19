import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { QRCodeSVG } from 'qrcode.react'
import { ThumbsUp, WifiOff, Settings, Plus, Minus, QrCode, ArrowUpDown, Clock, ChevronsUpDown } from 'lucide-react'
import { useAuraColor } from '../hooks/useAuraColor'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'

const POLL_INTERVAL = 1000

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

// Brightness Booster Helper
function getVibrantColor(rgbString) {
  if (!rgbString) return '#1DB954'

  let [r, g, b] = rgbString.split(',').map(Number)
  const max = Math.max(r, g, b)

  if (max < 30) return 'rgb(180, 180, 180)'

  if (max < 200) {
    const multiplier = 200 / max
    r = Math.round(r * multiplier)
    g = Math.round(g * multiplier)
    b = Math.round(b * multiplier)
  }

  return `rgb(${r}, ${g}, ${b})`
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

  const [showQR, setShowQR] = useState(true)

  // Tunable Sync & Visual Offsets
  const [lyricOffset, setLyricOffset] = useState(300)      // Time offset (ms)
  const [heightOffset, setHeightOffset] = useState(0)      // Vertical position (px)
  const [lineSpacing, setLineSpacing] = useState(32)       // NEW: Gap between text lines (px)

  // Dynamic height calculation
  const [dynamicTranslateY, setDynamicTranslateY] = useState(0)
  const lyricsContainerRef = useRef(null)

  const nowPlayingRef = useRef(null)
  const lastFetchedAtRef = useRef(null)
  const progressTimerRef = useRef(null)
  const progressBarRef = useRef(null)

  const auraColor = useAuraColor(nowPlaying?.album_art)
  const appUrl = queueUrl || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '')

  function getPlaybackMs() {
    const track = nowPlayingRef.current
    if (!track || !track.is_playing) return track?.progress_ms ?? 0
    return (track.progress_ms ?? 0) + (Date.now() - (lastFetchedAtRef.current || Date.now()))
  }

  // API Polling
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

        if (track) {
          const oldTrack = nowPlayingRef.current;
          let predictedMs = 0;

          if (oldTrack && oldTrack.id === track.id && oldTrack.is_playing) {
            predictedMs = (oldTrack.progress_ms ?? 0) + (Date.now() - (lastFetchedAtRef.current || Date.now()));
          }

          // Solo resincroniza si cambió la canción, el estado (pausa/play) o si el lag/desfase es mayor a 1.5s
          if (
              !oldTrack ||
              oldTrack.id !== track.id ||
              oldTrack.is_playing !== track.is_playing ||
              Math.abs(predictedMs - track.progress_ms) > 1500
          ) {
            nowPlayingRef.current = track;
            lastFetchedAtRef.current = Date.now();
          } else {
            // Mantiene el tiempo local fluido, solo actualiza metadatos
            nowPlayingRef.current = {
              ...track,
              progress_ms: oldTrack.progress_ms
            };
            // No actualizamos lastFetchedAtRef para que siga contando suavemente
          }
        } else {
          nowPlayingRef.current = null;
        }

        setNowPlaying(track);

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

  // Progress Timer (Animación Ultra-Fluida a 60/120 FPS)
  useEffect(() => {
    let animationFrameId;

    const tick = () => {
      const track = nowPlayingRef.current;
      if (!track?.duration_ms) {
        animationFrameId = requestAnimationFrame(tick);
        return;
      }

      const currentMs = getPlaybackMs();

      // 1. EL TRUCO DE RENDIMIENTO: Actualizamos la barra directamente en el DOM
      // Nos saltamos el "setProgress" para que React no re-renderice la pantalla pesada.
      if (progressBarRef.current) {
        const percent = Math.min((currentMs / track.duration_ms) * 100, 100);
        progressBarRef.current.style.width = `${percent}%`;
      }

      // 2. LYRICS ENGINE: Solo actualizamos si REALMENTE cambió la línea
      if (track.lyrics?.lines?.length) {
        const nextIndex = computeLyricLineIndex(track.lyrics.lines, currentMs + lyricOffset);

        setCurrentLyricIndex(prevIndex => {
          // Al retornar lo mismo si no hay cambio, React ignora el re-render.
          if (prevIndex !== nextIndex) return nextIndex;
          return prevIndex;
        });
      }

      // Volvemos a pedir el siguiente frame sincronizado con la pantalla
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(animationFrameId);
  }, [lyricOffset]);

  // DYNAMIC SCROLL ENGINE (Now reacts to lineSpacing changes instantly!)
  useEffect(() => {
    const calculateOffset = () => {
      if (lyricsContainerRef.current) {
        const activeEl = lyricsContainerRef.current.children[currentLyricIndex]
        if (activeEl) {
          setDynamicTranslateY(-(activeEl.offsetTop + activeEl.offsetHeight / 2) + heightOffset)
        }
      }
    }

    // Using a tiny timeout to ensure DOM has painted the new padding before measuring
    setTimeout(calculateOffset, 10)
    window.addEventListener('resize', calculateOffset)
    return () => window.removeEventListener('resize', calculateOffset)
  }, [currentLyricIndex, nowPlaying?.lyrics?.lines, heightOffset, lineSpacing])

  const progressPercent = nowPlaying ? progress : 0
  const dynamicColor = getVibrantColor(auraColor)

  return (
      <div className="fixed inset-0 bg-black text-white flex flex-col overflow-hidden select-none font-display uppercase tracking-tighter">

        {/* DYNAMIC BACKGROUND AURA */}
        {nowPlaying?.album_art && (
            <>
              <div
                  className="absolute inset-0 z-0 transition-all duration-[3000ms] opacity-50 blur-[200px] scale-150 animate-pulse-slow"
                  style={{ backgroundImage: `url(${nowPlaying.album_art})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              />
              <div className="absolute inset-0 z-1 bg-black/60" />
            </>
        )}

        {/* GHOST SYNC & SETTINGS CONTROLS */}
        <div className="absolute bottom-6 left-6 z-50 flex items-center gap-4 bg-black/60 backdrop-blur-md border border-white/10 p-2 rounded-full opacity-0 hover:opacity-100 transition-opacity duration-500 group">
          <Settings className="w-4 h-4 text-white/50 ml-2 group-hover:animate-spin" />

          {/* 1. Time Offset Menu */}
          <div className="flex items-center gap-1 bg-white/10 rounded-full p-1" title="Adjust Lyric Timing (ms)">
            <Clock className="w-3.5 h-3.5 text-white/50 ml-2" />
            <button onClick={() => setLyricOffset(prev => prev - 50)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Minus className="w-4 h-4 text-white" />
            </button>
            <span className="w-16 text-center text-xs font-black font-mono text-white/80">{lyricOffset}ms</span>
            <button onClick={() => setLyricOffset(prev => prev + 50)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Plus className="w-4 h-4 text-white" />
            </button>
          </div>

          <div className="w-px h-6 bg-white/20" />

          {/* 2. Height Anchor Offset Menu */}
          <div className="flex items-center gap-1 bg-white/10 rounded-full p-1" title="Adjust Vertical Anchor Position (px)">
            <ArrowUpDown className="w-3.5 h-3.5 text-white/50 ml-2" />
            <button onClick={() => setHeightOffset(prev => prev - 25)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Minus className="w-4 h-4 text-white" />
            </button>
            <span className="w-16 text-center text-xs font-black font-mono text-white/80">{heightOffset > 0 ? `+${heightOffset}` : heightOffset}px</span>
            <button onClick={() => setHeightOffset(prev => prev + 25)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Plus className="w-4 h-4 text-white" />
            </button>
          </div>

          <div className="w-px h-6 bg-white/20" />

          {/* 3. Text Spacing / Gap Menu */}
          <div className="flex items-center gap-1 bg-white/10 rounded-full p-1" title="Adjust Text Spacing/Gap (px)">
            <ChevronsUpDown className="w-3.5 h-3.5 text-white/50 ml-2" />
            <button onClick={() => setLineSpacing(prev => Math.max(0, prev - 8))} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Minus className="w-4 h-4 text-white" />
            </button>
            <span className="w-16 text-center text-xs font-black font-mono text-white/80">{lineSpacing}px</span>
            <button onClick={() => setLineSpacing(prev => prev + 8)} className="p-2 hover:bg-white/20 rounded-full transition-colors">
              <Plus className="w-4 h-4 text-white" />
            </button>
          </div>

          <div className="w-px h-6 bg-white/20" />

          <button
              onClick={() => setShowQR(!showQR)}
              className={cn("p-3 rounded-full transition-colors", showQR ? "bg-white/20 text-white" : "hover:bg-white/10 text-white/50")}
              title="Toggle QR Code"
          >
            <QrCode className="w-4 h-4" />
          </button>
        </div>

        <div className="relative z-10 flex flex-col sm:flex-row flex-1 min-h-0">

          {/* --- LEFT: MAIN FOCUS AREA --- */}
          <div className="flex-[2.4] flex flex-col p-10 min-h-0 overflow-hidden relative border-r border-white/10">

            {/* PROGRESS BAR */}
            <div className="absolute top-0 left-0 right-0 h-2 bg-white/5 z-50">
              <div
                  className="h-full transition-all duration-300 ease-linear"
                  ref={progressBarRef}
                  style={{
                    width: `${progressPercent}%`,
                    backgroundColor: dynamicColor,
                    boxShadow: `0 0 25px ${dynamicColor}`
                  }}
              />
            </div>

            {!initialized || !nowPlaying ? (
                <div className="flex-1 flex items-center justify-center text-white/20 font-black text-6xl">SYNCING...</div>
            ) : (
                <div className="w-full h-full flex flex-col gap-10 mt-6">

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
                        <div className="absolute top-[40%] left-0 right-0 flex flex-col items-center pointer-events-none">
                          <div
                              ref={lyricsContainerRef}
                              className="w-full flex flex-col items-center transition-transform duration-[1200ms]"
                              style={{
                                transform: `translateY(${dynamicTranslateY}px)`,
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
                                        // NEW: Apply the live, tweakable spacing state directly to the padding!
                                        paddingTop: `${lineSpacing}px`,
                                        paddingBottom: `${lineSpacing}px`,
                                        transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)'
                                      }}
                                  >
                                    <p className={cn(
                                        "text-5xl sm:text-[5rem] leading-[1.15] font-black drop-shadow-[0_15px_40px_rgba(0,0,0,0.8)] transition-colors duration-[1200ms]",
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
          <div className="flex-1 flex flex-col overflow-hidden bg-black/70 backdrop-blur-3xl">
            <div className="flex-1 flex flex-col overflow-hidden p-10 pb-0">
              <div className="flex justify-between items-center mb-8 px-4">
                <h3 className="text-lg font-black tracking-[0.6em] text-white/30 italic">UP NEXT</h3>
                <span className="bg-white/10 px-3 py-1 rounded-full text-xs font-black text-white">{upNext.length} TRACKS</span>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 no-scrollbar">
                {upNext.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-white/5 font-black text-3xl italic tracking-widest text-center px-4">Waitlist Empty</div>
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
                                className="flex items-center gap-5 p-4 rounded-[2.5rem] bg-white/[0.05] border border-white/10 shadow-xl"
                            >
                              <span className="text-white/20 font-black text-2xl italic w-8 text-center shrink-0">{i + 1}</span>
                              <img src={track.album_art} className="w-14 h-14 rounded-2xl object-cover shadow-md shrink-0" alt="" />
                              <div className="flex-1 min-w-0">
                                <p className="font-black text-base text-white truncate leading-none mb-1.5">{track.track_name}</p>
                                <p className="text-zinc-400 text-[10px] font-black tracking-widest truncate uppercase">{track.artist_name}</p>
                              </div>
                              <div className="bg-white/10 px-4 py-2.5 rounded-2xl flex items-center gap-2 border border-white/5 shrink-0">
                                <span className="text-white font-black text-lg">{track.votes}</span>
                                <ThumbsUp className="h-4 w-4 text-white/50" />
                              </div>
                            </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                )}
              </div>
            </div>

            {/* TOGGLEABLE QR SECTION */}
            {appUrl && showQR && (
                <div className="shrink-0 p-10 bg-black/40 border-t border-white/10 transition-all duration-500">
                  <div className="flex items-center gap-8">
                    <div className="w-32 h-32 bg-white p-3 shrink-0 shadow-2xl ring-4 ring-white/5 rounded-3xl">
                      <QRCodeSVG value={appUrl} width="100%" height="100%" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-black text-4xl text-white italic tracking-tighter leading-none">JOIN PARTY</h4>
                      <p className="text-zinc-400 font-black text-[11px] tracking-[0.2em] mt-3 truncate uppercase">{appUrl}</p>
                    </div>
                  </div>
                </div>
            )}
          </div>
        </div>
      </div>
  )
}