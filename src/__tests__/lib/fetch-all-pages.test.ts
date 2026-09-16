import { describe, it, expect, vi } from "vitest";
import { fetchAllPages, type PageResult } from "@/lib/fetch-all-pages";

interface Row {
  id: number;
}

/**
 * A fake table ordered by descending `id`, served by keyset: each page returns
 * rows strictly "after" (below) the cursor. `insertBetweenPages` prepends rows
 * — the way a live log table gains entries mid-read — so the tests can show
 * that a cursor is unaffected by arrivals in front of it.
 */
function fakeTable(opts: {
  total: number;
  pageSize: number;
  insertBetweenPages?: number;
}) {
  const { total, pageSize, insertBetweenPages = 0 } = opts;
  // Descending ids, newest (highest) first — the shape of a log table.
  let table = Array.from({ length: total }, (_, i) => ({ id: total - i }));
  let nextNewId = total + 1;
  let pageCount = 0;

  const fetchPage = vi.fn(async (cursor: Row | null): Promise<PageResult<Row>> => {
    if (pageCount > 0) {
      for (let i = 0; i < insertBetweenPages; i++) {
        // A newer row sorts to the very front, shifting every offset by one.
        table = [{ id: nextNewId++ }, ...table];
      }
    }
    pageCount++;

    const after = cursor ? table.filter((r) => r.id < cursor.id) : table;
    return { data: after.slice(0, pageSize), error: null };
  });

  return { fetchPage, tableSize: () => table.length };
}

describe("fetchAllPages", () => {
  it("returns every row when the table spans several pages", async () => {
    const { fetchPage } = fakeTable({ total: 2500, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });
    expect(result.rows).toHaveLength(2500);
    expect(result.truncated).toBe(false);
  });

  it("advances by cursor so no row is read twice", async () => {
    const { fetchPage } = fakeTable({ total: 2500, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });
    const ids = result.rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("neither duplicates nor drops rows when the table is written during the read", async () => {
    // The regression this design exists for. With offset paging, each row
    // inserted between pages pushes the boundary row of page N onto the head of
    // page N+1, so it is counted twice while a row at the far end goes unread —
    // and the report still looks complete.
    const { fetchPage } = fakeTable({ total: 5000, pageSize: 1000, insertBetweenPages: 3 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });

    const ids = result.rows.map((r) => r.id);
    expect(new Set(ids).size, "a row was returned more than once").toBe(ids.length);
    // Every row present when the read began is accounted for. Rows that arrived
    // afterwards sort in front of the cursor and are simply not seen, which is
    // the correct reading of a snapshot.
    const original = Array.from({ length: 5000 }, (_, i) => 5000 - i);
    expect(ids).toEqual(original);
  });

  it("passes null as the first cursor and the last row of each page thereafter", async () => {
    const { fetchPage } = fakeTable({ total: 2500, pageSize: 1000 });
    await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });
    const cursors = fetchPage.mock.calls.map(([c]) => c);
    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toEqual({ id: 1501 }); // 2500 down to 1501 is page one
    expect(cursors[2]).toEqual({ id: 501 });
  });

  it("stops on a short page rather than requesting past the end", async () => {
    const { fetchPage } = fakeTable({ total: 1500, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });
    expect(result.rows).toHaveLength(1500);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("handles an empty result without a second request", async () => {
    const { fetchPage } = fakeTable({ total: 0, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("handles a table that ends exactly on a page boundary", async () => {
    const { fetchPage } = fakeTable({ total: 2000, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 });
    expect(result.rows).toHaveLength(2000);
    expect(result.truncated).toBe(false);
  });

  it("caps at maxRows and reports truncation when rows remain", async () => {
    const { fetchPage } = fakeTable({ total: 5000, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 3000 });
    expect(result.rows).toHaveLength(3000);
    expect(result.truncated).toBe(true);
  });

  it("does NOT claim truncation when the data ends exactly at maxRows", async () => {
    // A false "your report is partial" costs as much trust as silent
    // truncation — it teaches the reader to disbelieve a correct page.
    const { fetchPage } = fakeTable({ total: 3000, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 3000 });
    expect(result.rows).toHaveLength(3000);
    expect(result.truncated).toBe(false);
    // Three pages plus the probe past the cap.
    expect(fetchPage).toHaveBeenCalledTimes(4);
  });

  it("stops early when shouldContinue goes false, and flags the read aborted", async () => {
    const { fetchPage } = fakeTable({ total: 10_000, pageSize: 1000 });
    let pagesSeen = 0;
    const result = await fetchAllPages(fetchPage, {
      pageSize: 1000,
      maxRows: 50_000,
      shouldContinue: () => pagesSeen++ < 2,
    });

    expect(result.aborted).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(2000);
    // The prefix must never be mistaken for a capped-but-complete read.
    expect(result.truncated).toBe(false);
  });

  it("reports aborted=false on a read that runs to completion", async () => {
    const { fetchPage } = fakeTable({ total: 1500, pageSize: 1000 });
    const result = await fetchAllPages(fetchPage, {
      pageSize: 1000,
      maxRows: 50_000,
      shouldContinue: () => true,
    });
    expect(result.aborted).toBe(false);
    expect(result.rows).toHaveLength(1500);
  });

  it("does not issue the truncation probe for a read aborted at the cap", async () => {
    const { fetchPage } = fakeTable({ total: 10_000, pageSize: 1000 });
    let allowed = 3;
    const result = await fetchAllPages(fetchPage, {
      pageSize: 1000,
      maxRows: 3000,
      shouldContinue: () => allowed-- > 0,
    });
    expect(result.aborted).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("throws on a page error rather than returning a short read", async () => {
    // Swallowing the error would hand back a partial set that looks whole,
    // which is the precise failure being designed out.
    const fetchPage = vi
      .fn<(cursor: Row | null) => Promise<PageResult<Row>>>()
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, (_, i) => ({ id: 1000 - i })),
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: "statement timeout" } });

    await expect(
      fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 50_000 }),
    ).rejects.toThrow("statement timeout");
  });

  it("propagates an error from the truncation probe", async () => {
    const fetchPage = vi
      .fn<(cursor: Row | null) => Promise<PageResult<Row>>>()
      .mockResolvedValueOnce({
        data: Array.from({ length: 1000 }, (_, i) => ({ id: 1000 - i })),
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: "probe failed" } });

    await expect(fetchAllPages(fetchPage, { pageSize: 1000, maxRows: 1000 })).rejects.toThrow(
      "probe failed",
    );
  });

  it("rejects nonsensical options instead of looping forever", async () => {
    const { fetchPage } = fakeTable({ total: 10, pageSize: 1000 });
    await expect(fetchAllPages(fetchPage, { pageSize: 0 })).rejects.toThrow(/pageSize/);
    await expect(fetchAllPages(fetchPage, { maxRows: 0 })).rejects.toThrow(/maxRows/);
  });
});
