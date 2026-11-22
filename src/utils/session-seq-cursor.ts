/**
 * Resume cursor for `/sockets/session/{id}`.
 *
 * Durable frames are not delivered in `seq` order — a state update can overtake
 * the message persisted just before it — so resuming from the highest seq seen
 * would skip whatever was still in flight when the socket dropped. The cursor
 * is instead the highest seq with nothing missing below it.
 */
export interface SeqCursor {
  /** Highest seq with no gap below it, or `null` before the first connect. */
  readonly value: number | null;
  /** Begin a connection that replays everything after `base`. */
  start: (base: number) => void;
  observe: (seq: number) => void;
  /**
   * Whether a stepped-over hole is waiting to be refetched (never consumed).
   * The socket owner checks this after each observe and recycles the
   * connection when it turns true.
   */
  hasPendingRefetch: () => boolean;
  /**
   * Consume the pending refetch request: the base to replay from — one below
   * the hole — or `null` when nothing is pending. Consumed by the connect
   * params so the next connection replays the skipped range and the store
   * dedups the redelivery.
   */
  takeRefetchBase: () => number | null;
  clear: () => void;
}

/**
 * How far past a gap to wait before stepping over it. The server skips events
 * it cannot read, and that seq never arrives — on this connection or any
 * later one — so an unbounded wait would freeze the cursor at the hole and
 * replay from it on every reconnect.
 */
const MAX_AHEAD = 1024;

export function createSeqCursor(): SeqCursor {
  let value: number | null = null;
  let ahead = new Set<number>();
  /**
   * Holes already reported for refetch, keyed by the first missing seq. A
   * hole the server itself cannot serve re-forms after the refetch replay
   * (the client starts below it and the seq is skipped again); reporting it
   * once turns that second step-over into a no-op instead of a reconnect
   * loop. A hole is only ever reported once per conversation (`clear`).
   */
  let reportedHoles = new Set<number>();
  /** Unconsumed refetch request, as the base to replay from. */
  let refetchBase: number | null = null;

  const drain = () => {
    while (value !== null && ahead.has(value + 1)) {
      value += 1;
      ahead.delete(value);
    }
  };

  return {
    get value() {
      return value;
    },
    start: (base) => {
      value = base;
      // Anything seen past a gap is replayed on this connection and deduped.
      ahead = new Set();
      // Hole reports survive a restart: a refetch replay re-forms the same
      // hole, and re-reporting it would loop.
    },
    observe: (seq) => {
      if (value === null || seq <= value) {
        return;
      }
      ahead.add(seq);
      drain();
      if (ahead.size > MAX_AHEAD) {
        // Step over the hole: the skipped event is unreadable on replay too.
        const holeFrom = value + 1;
        value = Math.min(...ahead) - 1;
        drain();
        // Ask for one replay from below the hole. A dropped batch is
        // redelivered by the server (the store dedups it); a hole the server
        // cannot serve re-forms and is proven permanent rather than silently
        // swallowed.
        if (!reportedHoles.has(holeFrom)) {
          reportedHoles.add(holeFrom);
          refetchBase = holeFrom - 1;
        }
      }
    },
    hasPendingRefetch: () => refetchBase !== null,
    takeRefetchBase: () => {
      const base = refetchBase;
      refetchBase = null;
      return base;
    },
    clear: () => {
      value = null;
      ahead = new Set();
      reportedHoles = new Set();
      refetchBase = null;
    },
  };
}
