export type Totals = {
  input: number
  output: number
  cacheRead: number
  write5m: number
  write1h: number
  requests: number
  subagentRequests: number
}

// Epoch milliseconds when the newest live entry of each tier expires; null
// until the session has written that tier.
export type CacheTimers = { until5m: number | null; until1h: number | null }

declare module 'claude-code' {
  interface PluginState {
    'token-distribution': {
      totals: Shaped<Totals>
      timers: Shaped<CacheTimers>
      now: number
      problem: string | null
      isHidden: boolean
      isOpen: boolean
    }
  }
}
