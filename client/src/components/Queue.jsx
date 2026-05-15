import { useState, useEffect } from 'react'
import axios from 'axios'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'

function Queue({ fingerprintId }) {
  const [queue, setQueue] = useState([])
  const [userVotes, setUserVotes] = useState({})
  const [loading, setLoading] = useState(true)

  // NEW: State to track if the Admin has enabled downvotes
  const [downvoteEnabled, setDownvoteEnabled] = useState(true)

  const fetchVotingQueue = async () => {
    try {
      const [queueRes, votesRes] = await Promise.all([
        axios.get('/api/queue/voting-list'),
        axios.get('/api/queue/votes', { params: { fingerprint_id: fingerprintId } })
      ]);
      setQueue(queueRes.data)
      setUserVotes(votesRes.data.userVotes || {})

      // Catch the admin setting from the backend response
      setDownvoteEnabled(votesRes.data.downvoteEnabled !== false)

    } catch (e) {
      console.error("Failed to fetch voting queue", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchVotingQueue()
    const interval = setInterval(fetchVotingQueue, 3000)
    return () => clearInterval(interval)
  }, [fingerprintId])

  const handleVote = async (trackId, direction) => {
    if (!fingerprintId) return

    try {
      await axios.post('/api/queue/quick-vote', {
        track_id: trackId,
        direction: direction,
        fingerprint_id: fingerprintId
      })
      fetchVotingQueue()
    } catch (e) {
      console.error(`Vote ${direction} failed`, e)
    }
  }

  if (loading) return null
  if (queue.length === 0) return (
      <div className="mt-6 text-center text-muted-foreground font-semibold">
        The waitlist is empty. Search for a song to start the party!
      </div>
  )

  return (
      <div className="mt-6">
        <h2 className="text-lg font-black tracking-widest uppercase mb-4 text-zinc-400">Waitlist</h2>

        <div className="flex flex-col gap-3 relative">
          <AnimatePresence mode="popLayout">
            {queue.map((track, i) => {
              const myVote = userVotes[track.track_id];
              const isUpvoted = myVote === 1;
              const isDownvoted = myVote === -1;

              return (
                  <motion.div
                      layout
                      initial={{ opacity: 0, scale: 0.9, y: 20 }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                      transition={{ type: "spring", stiffness: 350, damping: 25, mass: 1 }}
                      key={track.track_id}
                      className="flex items-center gap-4 p-3 rounded-2xl border bg-card shadow-sm"
                  >
                  <span className="text-lg font-black text-muted-foreground w-6 text-center shrink-0 italic">
                    {i + 1}
                  </span>

                    {track.album_art && (
                        <img src={track.album_art} alt="" className="w-12 h-12 rounded-xl object-cover shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="font-bold truncate text-base leading-none mb-1">{track.track_name}</div>
                      <div className="text-[10px] text-muted-foreground truncate uppercase tracking-widest font-black">{track.artist_name}</div>
                    </div>

                    {/* Dual-Voting Controls */}
                    <div className="flex items-center gap-1 sm:gap-2 shrink-0 bg-muted/50 rounded-xl p-1 border">

                      {/* THUMBS DOWN BUTTON - ONLY RENDER IF ENABLED BY ADMIN */}
                      {downvoteEnabled && (
                          <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleVote(track.track_id, 'down')}
                              className={cn(
                                  "h-8 w-8 sm:px-2 p-0 rounded-lg transition-colors",
                                  isDownvoted
                                      ? "bg-red-500/20 text-red-600 hover:bg-red-500/30 hover:text-red-700"
                                      : "text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                              )}
                          >
                            <ThumbsDown className={cn("h-4 w-4", isDownvoted && "fill-current")} />
                          </Button>
                      )}

                      <span className="text-base font-black w-6 text-center">
                      {track.votes}
                    </span>

                      {/* THUMBS UP BUTTON */}
                      <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleVote(track.track_id, 'up')}
                          className={cn(
                              "h-8 w-8 sm:px-2 p-0 rounded-lg transition-colors",
                              isUpvoted
                                  ? "bg-green-500/20 text-green-600 hover:bg-green-500/30 hover:text-green-700"
                                  : "text-muted-foreground hover:bg-green-500/10 hover:text-green-500"
                          )}
                      >
                        <ThumbsUp className={cn("h-4 w-4", isUpvoted && "fill-current")} />
                      </Button>

                    </div>
                  </motion.div>
              )
            })}
          </AnimatePresence>
        </div>
      </div>
  )
}

export default Queue