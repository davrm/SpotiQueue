import { useState, useEffect } from 'react'
import axios from '@/lib/api'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'

function SpotifyConnect() {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [disconnecting, setDisconnecting] = useState(false)

  // CrowdPlay specific states
  const [pushing, setPushing] = useState(false)
  const [pushMessage, setPushMessage] = useState(null)
  const [isError, setIsError] = useState(false)
  const [engineActive, setEngineActive] = useState(false)

  useEffect(() => { checkStatus() }, [])

  const checkStatus = async () => {
    try {
      const response = await axios.get('/api/auth/status')
      setStatus(response.data)

      // If connected, also check if the CrowdPlay engine is currently running
      if (response.data?.connected) {
        axios.get('/api/admin/engine-status')
            .then(res => setEngineActive(res.data.active))
            .catch(() => {})
      }
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

  // --- CROWDPLAY: Toggle Auto Engine ---
  const handleToggleEngine = async () => {
    setPushing(true)
    setPushMessage(null)
    setIsError(false)

    try {
      const res = await axios.post('/api/admin/toggle-engine')
      setPushMessage(res.data.message)
      setEngineActive(res.data.active)
    } catch (error) {
      setIsError(true)
      setPushMessage('Failed to toggle the auto-engine.')
    } finally {
      setPushing(false)
    }
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
        {/* Standard Spotify Connection Card */}
        <Card>
          <CardContent className="pt-6">
            <div className="text-center mb-6">
              <div className="text-sm font-bold text-primary mb-4">SPOTIFY</div>
              {isConnected ? (
                  <>
                    <h2 className="text-xl font-semibold mb-2">Spotify Connected</h2>
                    <p className="text-muted-foreground">Your Spotify account is connected. You can reconnect to refresh your token.</p>
                  </>
              ) : (
                  <>
                    <h2 className="text-xl font-semibold mb-2">Connect Your Spotify Account</h2>
                    <p className="text-muted-foreground">To queue songs, you need to connect your Spotify account.</p>
                  </>
              )}
            </div>
            {(!status?.hasClientId || !status?.hasClientSecret) && (
                <div className="rounded-lg bg-destructive/10 text-destructive p-3 mb-4 text-sm">
                  {!status?.hasClientId && <div>SPOTIFY_CLIENT_ID not configured. Add it to .env</div>}
                  {!status?.hasClientSecret && <div>SPOTIFY_CLIENT_SECRET not configured. Add it to .env</div>}
                </div>
            )}
            {showConnectButton && (
                <div className="flex gap-2 justify-center flex-wrap mb-4">
                  <Button onClick={handleConnect}>
                    {isConnected ? 'Reconnect Spotify Account' : 'Connect Spotify Account'}
                  </Button>
                  {isConnected && (
                      <Button variant="destructive" onClick={handleDisconnect} disabled={disconnecting}>
                        {disconnecting ? 'Disconnecting...' : 'Disconnect Account'}
                      </Button>
                  )}
                </div>
            )}
            {isConnected && (
                <div className="rounded-lg border p-4 mt-4">
                  <h3 className="font-semibold mb-2">Connection Details</h3>
                  <p className="text-sm"><strong>Status:</strong> Connected</p>
                  <p className="text-sm"><strong>User ID:</strong> {status?.userId || 'Not available'}</p>
                </div>
            )}
          </CardContent>
        </Card>
      </div>
  )
}

export default SpotifyConnect