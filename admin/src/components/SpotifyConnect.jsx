import { useState, useEffect } from 'react'
import axios from '@/lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { Activity, ShieldX, CheckCircle2 } from 'lucide-react'

function SpotifyConnect() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)
  const [apiStats, setApiStats] = useState({ rpm: 0, status: 'SAFE', locked: false })

  useEffect(() => {
    checkStatus()

    // Poll API Traffic stats every 3 seconds to animate the progress bar
    const statsInterval = setInterval(() => {
      axios.get('/api/admin/spotify/stats')
          .then(res => setApiStats(res.data))
          .catch(() => {})
    }, 3000)

    return () => clearInterval(statsInterval)
  }, [])

  const checkStatus = async () => {
    try {
      const response = await axios.get('/api/auth/status')
      setStatus(response.data)
    } catch (error) {
      setStatus({
        connected: false,
        hasRefreshToken: false,
        hasClientId: false,
        hasClientSecret: false
      })
    }
    finally { setLoading(false) }
  }

  const handleConnect = async () => {
    try {
      const response = await axios.get('/api/auth/authorize?t=' + Date.now())
      window.location.href = response.data.authUrl
    } catch (error) {
      alert('Failed to start authorization. Please check your Spotify credentials in .env file.')
    }
  }

  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect your Spotify account?')) return
    setDisconnecting(true)
    try {
      await axios.post('/api/auth/disconnect')
      await checkStatus()
      alert('Spotify account disconnected successfully.')
    } catch (error) {
      alert('Failed to disconnect: ' + (error.response?.data?.error || error.message))
    }
    finally { setDisconnecting(false) }
  }

  if (loading) {
    return (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Checking connection status...
          </CardContent>
        </Card>
    )
  }

  const showConnectButton = status?.hasClientId && status?.hasClientSecret
  const isConnected = status?.connected

  return (
      <div className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-center mb-6">
              <div className="text-sm font-bold text-primary mb-4">SPOTIFY</div>
              {isConnected ? (
                  <>
                    <h2 className="text-xl font-semibold mb-2">Spotify Connected</h2>
                    <p className="text-muted-foreground">Your Spotify account is securely linked.</p>
                  </>
              ) : (
                  <>
                    <h2 className="text-xl font-semibold mb-2">Connect Your Spotify Account</h2>
                    <p className="text-muted-foreground">To host a party, you must securely connect your premium account.</p>
                  </>
              )}
            </div>

            {(!status?.hasClientId || !status?.hasClientSecret) && (
                <div className="rounded-lg bg-destructive/10 text-destructive p-3 mb-4 text-sm font-bold border border-destructive/20 text-center">
                  {!status?.hasClientId && <div>⚠️ SPOTIFY_CLIENT_ID missing in .env</div>}
                  {!status?.hasClientSecret && <div>⚠️ SPOTIFY_CLIENT_SECRET missing in .env</div>}
                </div>
            )}

            {showConnectButton && (
                <div className="flex gap-2 justify-center flex-wrap mb-4">
                  <Button onClick={handleConnect}>
                    {isConnected ? 'Reconnect Account' : 'Connect Spotify Account'}
                  </Button>
                  {isConnected && (
                      <Button variant="destructive" onClick={handleDisconnect} disabled={disconnecting}>
                        {disconnecting ? 'Disconnecting...' : 'Disconnect Account'}
                      </Button>
                  )}
                </div>
            )}

            {isConnected && (
                <div className="mt-8 space-y-4">
                  {/* Connection Details */}
                  <div className="rounded-xl border bg-card p-5">
                    <h3 className="font-bold mb-3 flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-500" /> Connection Active
                    </h3>
                    <p className="text-sm text-muted-foreground"><strong>User ID:</strong> {status?.userId || 'Not available'}</p>
                  </div>

                  {/* API Traffic Meter */}
                  <div className="rounded-xl border bg-card p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="font-bold flex items-center gap-2">
                        <Activity className="h-5 w-5 text-primary" /> API Traffic Monitor
                      </h3>
                      <div className={`text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md text-white ${apiStats.status === 'SAFE' ? 'bg-green-500' : apiStats.status === 'WARNING' ? 'bg-yellow-500' : apiStats.status === 'DANGER' ? 'bg-orange-500' : 'bg-red-600 animate-pulse'}`}>
                        {apiStats.status === 'SAFE' ? 'Healthy' : apiStats.status === 'WARNING' ? 'Elevated' : apiStats.status === 'DANGER' ? 'Critical' : 'BLOCKED'}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-xs font-mono text-muted-foreground">
                        <span>{apiStats.rpm} Requests / min</span>
                        <span>Max ~60</span>
                      </div>
                      <div className="h-3 w-full bg-secondary rounded-full overflow-hidden">
                        <div
                            className={`h-full transition-all duration-500 ${apiStats.status === 'SAFE' ? 'bg-green-500' : apiStats.status === 'WARNING' ? 'bg-yellow-500' : 'bg-red-500'}`}
                            style={{ width: `${Math.min((apiStats.rpm / 60) * 100, 100)}%` }}
                        />
                      </div>
                      {apiStats.locked && (
                          <div className="mt-4 p-3 bg-red-500/10 text-red-500 text-xs rounded-lg flex items-start gap-2 border border-red-500/20">
                            <ShieldX className="h-4 w-4 shrink-0 mt-0.5" />
                            <p><strong>Rate Limit Active:</strong> Spotify temporarily blocked requests. The backend is securely holding all outgoing requests in the cache to clear the penalty.</p>
                          </div>
                      )}
                    </div>
                  </div>
                </div>
            )}
          </CardContent>
        </Card>
      </div>
  )
}

export default SpotifyConnect