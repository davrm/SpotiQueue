import { useState, useEffect } from 'react'
import axios from 'axios'
import { ThumbsUp } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'
import { motion, AnimatePresence } from 'framer-motion'

function Queue({ fingerprintId }) {
  // queue will now hold our array of songs from the local database
  const [queue, setQueue] = useState([])
  const [loading, setLoading] = useState(true)

  // 1. Fetch from our new custom endpoint
  const fetchVotingQueue = async () => {
    try {
      const res = await axios.get('/api/queue/voting-list')
      setQueue(res.data)
    } catch (e) {
      console.error("Failed to fetch voting queue", e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchVotingQueue()
    // Poll the database every 3 seconds to update votes in real-time
    const interval = setInterval(fetchVotingQueue, 3000)
    return () => clearInterval(interval)
  }, [])

  // 2. Handle clicking the Upvote button on the list
  const handleVote = async (trackId) => {
    if (!fingerprintId) return
    try {
      await axios.post('/api/queue/add', {
        track_id: trackId,
        fingerprint_id: fingerprintId
      })
      // Immediately refresh the list to show the new vote count
      fetchVotingQueue()
    } catch (e) {
      console.error("Vote failed", e)
    }
  }

  if (loading) return null
  if (queue.length === 0) return (
      <div className="mt-6 text-center text-muted-foreground">
        The voting queue is empty. Search for a song to start the party!
      </div>
  )

  return (
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3">Waitlist</h2>

        {/* We use a standard div wrapper here instead of space-y so the margins don't mess up the layout animation */}
        <div className="flex flex-col gap-2 relative">

          {/* AnimatePresence allows elements to animate smoothly when added or removed */}
          <AnimatePresence mode="popLayout">
            {queue.map((track, i) => (
                <motion.div
                    // The "layout" prop is the magic that creates the smooth reordering glide!
                    layout
                    initial={{ opacity: 0, scale: 0.9, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
                    transition={{
                      type: "spring",
                      stiffness: 350,
                      damping: 25,
                      mass: 1
                    }}
                    key={track.track_id}
                    className="flex items-center gap-3 p-3 rounded-lg border bg-card shadow-sm"
                >
                  {/* Position Number */}
                  <span className="text-sm font-bold text-muted-foreground w-6 text-right shrink-0">
                    {i + 1}
                  </span>

                  {/* Album Art */}
                  {track.album_art && (
                      <img src={track.album_art} alt="" className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover shrink-0" />
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="font-bold truncate text-sm sm:text-base">{track.track_name}</div>
                    <div className="text-xs text-muted-foreground truncate uppercase tracking-widest">{track.artist_name}</div>
                  </div>

                  {/* Voting Controls */}
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleVote(track.track_id)}
                        className="h-9 w-9 sm:h-8 sm:w-auto sm:px-2 p-0 touch-manipulation hover:bg-green-500/10 hover:text-green-500 transition-colors"
                    >
                      <ThumbsUp className="h-4 w-4" />
                    </Button>
                    <span className="text-sm font-black min-w-[1.5rem] text-center">
                      {track.votes}
                    </span>
                  </div>
                </motion.div>
            ))}
          </AnimatePresence>
        </div>
      </div>
  )
}

export default Queue