import { describe, expect, it } from "vitest";
import { createSeqCursor } from "#/utils/session-seq-cursor";

describe("createSeqCursor", () => {
  it("is null until a connection starts it", () => {
    const cursor = createSeqCursor();
    cursor.observe(5);
    expect(cursor.value).toBeNull();
  });

  it("advances through contiguous seqs", () => {
    const cursor = createSeqCursor();
    cursor.start(-1);
    [0, 1, 2].forEach(cursor.observe);
    expect(cursor.value).toBe(2);
  });

  it("holds below a gap and closes it once the missing seq arrives", () => {
    const cursor = createSeqCursor();
    cursor.start(3);
    cursor.observe(5);
    cursor.observe(6);
    expect(cursor.value).toBe(3);

    cursor.observe(4);
    expect(cursor.value).toBe(6);
  });

  it("ignores replays at or below the cursor", () => {
    const cursor = createSeqCursor();
    cursor.start(10);
    cursor.observe(10);
    cursor.observe(2);
    expect(cursor.value).toBe(10);
  });

  it("forgets seqs past a gap on restart, since they are replayed", () => {
    const cursor = createSeqCursor();
    cursor.start(0);
    cursor.observe(2);
    cursor.start(cursor.value ?? -1);
    cursor.observe(1);
    expect(cursor.value).toBe(1);
  });

  it("clears back to no position", () => {
    const cursor = createSeqCursor();
    cursor.start(7);
    cursor.clear();
    expect(cursor.value).toBeNull();
  });

  it("reports a refetch base once when it steps over a hole", () => {
    const cursor = createSeqCursor();
    cursor.start(-1);
    cursor.observe(0);
    // Fill past MAX_AHEAD with seqs that skip 1: the cursor steps over the
    // hole and asks for one replay from below it.
    for (let seq = 2; seq <= 1026; seq += 1) {
      cursor.observe(seq);
    }
    expect(cursor.value).toBe(1026);
    expect(cursor.hasPendingRefetch()).toBe(true);
    expect(cursor.takeRefetchBase()).toBe(0);
    expect(cursor.takeRefetchBase()).toBeNull();
    expect(cursor.hasPendingRefetch()).toBe(false);
  });

  it("does not re-report the same hole when a refetch replay re-forms it", () => {
    const cursor = createSeqCursor();
    cursor.start(-1);
    cursor.observe(0);
    for (let seq = 2; seq <= 1026; seq += 1) {
      cursor.observe(seq);
    }
    expect(cursor.takeRefetchBase()).toBe(0);

    // The refetch connects below the hole and the server skips the seq
    // again — the hole re-forms but must not trigger a reconnect loop.
    // The replay from base -1 redelivers seq 0 as well.
    cursor.start(-1);
    cursor.observe(0);
    for (let seq = 2; seq <= 1026; seq += 1) {
      cursor.observe(seq);
    }
    expect(cursor.value).toBe(1026);
    expect(cursor.hasPendingRefetch()).toBe(false);
    expect(cursor.takeRefetchBase()).toBeNull();
  });

  it("reports a later, different hole after the first was consumed", () => {
    const cursor = createSeqCursor();
    cursor.start(-1);
    cursor.observe(0);
    for (let seq = 2; seq <= 1026; seq += 1) {
      cursor.observe(seq);
    }
    expect(cursor.takeRefetchBase()).toBe(0);

    // A second hole at seq 2000 forms after the first hole was stepped over.
    for (let seq = 1027; seq <= 1999; seq += 1) {
      cursor.observe(seq);
    }
    for (let seq = 2001; seq <= 3025; seq += 1) {
      cursor.observe(seq);
    }
    expect(cursor.value).toBe(3025);
    expect(cursor.takeRefetchBase()).toBe(1999);
    expect(cursor.takeRefetchBase()).toBeNull();
  });

  it("forgets hole reports on clear, since a new conversation has a new log", () => {
    const cursor = createSeqCursor();
    cursor.start(-1);
    cursor.observe(0);
    for (let seq = 2; seq <= 1026; seq += 1) {
      cursor.observe(seq);
    }
    cursor.clear();
    expect(cursor.hasPendingRefetch()).toBe(false);
    expect(cursor.takeRefetchBase()).toBeNull();
  });
});
