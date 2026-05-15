import { useState, useEffect } from 'react'
import axios from 'axios'
// We removed ThumbsDown since our simple SQL table only counts upvotes right now
import { ThumbsUp } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '@/lib/utils'

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
      // We can reuse the /add endpoint we modified earlier!
      // Since it uses "ON CONFLICT UPDATE votes + 1", sending the track ID again acts as an upvote.
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
        <h2 className="text-lg font-semibold mb-3">AutoEngine Voting Queue</h2>
        <div className="space-y-2">
          {queue.map((track, i) => (
              <div
                  key={track.track_id}
                  className="flex items-center gap-3 p-3 rounded-lg border bg-card"
              >
                <span className="text-sm text-muted-foreground w-6 shrink-0">{i + 1}</span>

                {/* 3. Updated property names to match our SQLite table columns */}
                {track.album_art && (
                    <img src={track.album_art} alt="" className="w-10 h-10 sm:w-12 sm:h-12 rounded-lg object-cover shrink-0" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{track.track_name}</div>
                  <div className="text-sm text-muted-foreground truncate">{track.artist_name}</div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleVote(track.track_id)}
                      className="h-9 w-9 sm:h-8 sm:w-auto sm:px-2 p-0 touch-manipulation"
                  >
                    <ThumbsUp className="h-4 w-4" />
                  </Button>
                  <span className="text-sm font-bold min-w-[1.5rem] text-center">
                {track.votes}
              </span>
                </div>
              </div>
          ))}
        </div>
      </div>
  )
}

export default Queue