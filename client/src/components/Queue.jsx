import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { ThumbsUp, ThumbsDown, Music } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'

function Queue({ fingerprintId, lastAddedTrackId, onTrackHighlighted }) {
  const [queue, setQueue] = useState([])
  const [userVotes, setUserVotes] = useState({})
  const [loading, setLoading] = useState(true)
  const [votingEnabled, setVotingEnabled] = useState(true)
  const [downvoteEnabled, setDownvoteEnabled] = useState(true)
  const [highlightedTrack, setHighlightedTrack] = useState(null)

  const trackRefs = useRef({})

  const fetchVotingQueue = async () => {
    try {
      const [queueRes, votesRes] = await Promise.all([
        axios.get('/api/queue/voting-list'),
        axios.get('/api/queue/votes', { params: { fingerprint_id: fingerprintId } })
      ]);
      setQueue(queueRes.data);
      setUserVotes(votesRes.data.userVotes || {});
      setVotingEnabled(votesRes.data.enabled !== false);
      setDownvoteEnabled(votesRes.data.downvoteEnabled !== false);
    } catch (e) {
      console.error("Error", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchVotingQueue();
    const interval = setInterval(fetchVotingQueue, 3000);
    return () => clearInterval(interval);
  }, [fingerprintId]);

  // Scroll a nueva canción
  useEffect(() => {
    if (lastAddedTrackId && trackRefs.current[lastAddedTrackId]) {
      trackRefs.current[lastAddedTrackId].scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedTrack({ id: lastAddedTrackId, type: 'add' });
      setTimeout(() => setHighlightedTrack(null), 2000);
      if (onTrackHighlighted) onTrackHighlighted();
    }
  }, [lastAddedTrackId, queue, onTrackHighlighted]);

  const handleVote = async (trackId, direction) => {
    if (!fingerprintId) return;

    // 1. Lógica de estado (Up/Down/Neutral)
    const dirInt = direction === 'up' ? 1 : -1;
    const currentVote = userVotes[trackId] || 0;

    // Si el usuario clica el mismo botón, se vuelve neutral
    const isNeutralizing = currentVote === dirInt;
    const newUserVote = isNeutralizing ? null : dirInt;
    const voteChange = isNeutralizing ? -dirInt : (currentVote !== 0 ? dirInt * 2 : dirInt);

    // 2. Optimistic Update (Instantánea)
    setUserVotes(prev => ({ ...prev, [trackId]: newUserVote }));
    setQueue(prev => {
      const updated = prev.map(t => t.track_id === trackId ? { ...t, votes: t.votes + voteChange } : t);
      return updated.sort((a, b) => b.votes - a.votes || a.added_at.localeCompare(b.added_at));
    });

    // 3. Feedback visual: Rojo, Verde o Blanco (neutral)
    setHighlightedTrack({ id: trackId, type: isNeutralizing ? 'neutral' : direction });

    try {
      // 3. Votamos en el servidor
      await axios.post('/api/queue/quick-vote', { track_id: trackId, direction, fingerprint_id: fingerprintId });

      // 4. Descargamos el nuevo orden.
      // Al hacer setQueue aquí, Framer Motion detecta el cambio de posición y mueve la tarjeta como flotando (gliding).
      await fetchVotingQueue();

      // 5. Esperamos 400ms (lo que tarda la animación visual de Framer Motion en deslizar la tarjeta)
      // y entonces, si la tarjeta se ha ido fuera de tu pantalla, hacemos un scroll suave hacia ella.
      setTimeout(() => {
        if (trackRefs.current[trackId]) {
          trackRefs.current[trackId].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        // Borramos el color al acabar
        setTimeout(() => setHighlightedTrack(null), 1000);
      }, 350);
    } catch (e) {
      console.error("Fallo al votar", e)
      setHighlightedTrack(null);
      fetchVotingQueue();
    }
  }

  if (loading) return null

  return (
      <div className="mt-6">
        <h2 className="text-lg font-black tracking-widest uppercase mb-4 text-zinc-400">Waitlist</h2>
        <div className="flex flex-col gap-3">
          <AnimatePresence initial={false}>
            {queue.map((track, i) => {
              const isUpvoted = userVotes[track.track_id] === 1;
              const isDownvoted = userVotes[track.track_id] === -1;
              const highlight = highlightedTrack?.id === track.track_id ? highlightedTrack.type : null;

              return (
                  <motion.div
                      layout
                      key={track.track_id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      transition={{
                        layout: { type: "spring", stiffness: 100, damping: 20 },
                        duration: 0.2
                      }}
                      ref={el => (trackRefs.current[track.track_id] = el)}
                      className={cn(
                          "flex items-center gap-4 p-3 rounded-2xl border bg-card transition-colors duration-300",
                          highlight === 'up' && "ring-2 ring-green-500 bg-green-500/10",
                          highlight === 'down' && "ring-2 ring-red-500 bg-red-500/10",
                          highlight === 'neutral' && "ring-2 ring-white bg-white/5" // Highlight blanco para neutral
                      )}
                  >
                    <span className="text-lg font-black text-muted-foreground w-6 text-center">{i + 1}</span>
                    <img src={track.album_art || ''} className="w-12 h-12 rounded-xl bg-muted object-cover" onError={(e) => e.target.style.display = 'none'} />

                    <div className="flex-1 min-w-0">
                      <div className="font-bold truncate">{track.track_name}</div>
                      <div className="text-xs text-muted-foreground truncate uppercase tracking-widest">{track.artist_name}</div>
                    </div>

                    {votingEnabled && (
                        <div className={cn(
                            "flex items-center gap-1 rounded-xl p-1 border transition-colors duration-300",
                            isUpvoted ? "bg-green-500/10 border-green-500/20" :
                                isDownvoted ? "bg-red-500/10 border-red-500/20" :
                                    "bg-muted/50 border-border"
                        )}>
                          {downvoteEnabled && (
                              <Button variant="ghost" size="sm" onClick={() => handleVote(track.track_id, 'down')} className={cn("h-9 w-9", isDownvoted && "text-red-500")}>
                                {/* fill-current rellena el icono si está activo */}
                                <ThumbsDown className={cn("h-5 w-5", isDownvoted && "fill-current")} />
                              </Button>
                          )}
                          <span className="font-black w-8 text-center">{track.votes}</span>
                          <Button variant="ghost" size="sm" onClick={() => handleVote(track.track_id, 'up')} className={cn("h-9 w-9", isUpvoted && "text-green-500")}>
                            {/* fill-current rellena el icono si está activo */}
                            <ThumbsUp className={cn("h-5 w-5", isUpvoted && "fill-current")} />
                          </Button>
                        </div>
                    )}
                  </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      </div>
  )
}

export default Queue