/**
 * Song library persistence.
 *
 * Two object stores, and the split is the point:
 *
 *   `songs`  one record per song: chart, tempo, analysis metadata (see SongRecord). Small.
 *   `audio`  `{ id, blob, mimeType }` — the encoded audio bytes, keyed by the same id.
 *
 * Listing the library reads only `songs`, so opening the song picker never touches tens of
 * megabytes of audio. Saving is a single transaction across both stores, so a half-written song
 * cannot be left behind by a crash or a reload.
 *
 * `SongStore` is an interface with two implementations:
 *
 *   - `IndexedDbSongStore` — the real one. IndexedDB is available in every browser this game
 *     targets (including Safari private mode, where it exists but may fail on write).
 *   - `MemorySongStore` — used when IndexedDB is missing or refuses to open (private-mode quota
 *     errors, embedded webviews) and by the tests. The library then *works* for the session and
 *     the UI says so, which is a much better failure mode than an import that silently cannot be
 *     saved.
 */

import {
  decodeSongRecord,
  encodeSongRecord,
  summarize,
  type SongRecord,
  type SongSummary,
} from './SongRecord';

export type { SongRecord, SongSummary };

export const LIBRARY_DB_NAME = 'seven-keys';
export const LIBRARY_DB_VERSION = 1;
export const SONGS_STORE = 'songs';
export const AUDIO_STORE = 'audio';

export interface StoredAudioBlob {
  id: string;
  blob: Blob;
  mimeType: string;
}

export interface LoadedSong {
  record: SongRecord;
  audio: Blob | null;
}

export interface SongStore {
  readonly kind: 'indexeddb' | 'memory';
  /** False when the store cannot persist across reloads (memory fallback). */
  readonly persistent: boolean;
  save(record: SongRecord, audio: StoredAudioBlob | null): Promise<void>;
  list(): Promise<SongSummary[]>;
  load(id: string): Promise<LoadedSong | null>;
  remove(id: string): Promise<void>;
  count(): Promise<number>;
  close(): void;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbSongStore implements SongStore {
  readonly kind = 'indexeddb' as const;
  readonly persistent = true;

  constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB): Promise<IndexedDbSongStore> {
    const request = factory.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SONGS_STORE)) {
        db.createObjectStore(SONGS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: 'id' });
      }
    };
    const db = await requestToPromise(request as IDBRequest<IDBDatabase>);
    return new IndexedDbSongStore(db);
  }

  async save(record: SongRecord, audio: StoredAudioBlob | null): Promise<void> {
    const tx = this.db.transaction([SONGS_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(SONGS_STORE).put(record);
    const audioStore = tx.objectStore(AUDIO_STORE);
    if (audio) audioStore.put(audio);
    else audioStore.delete(record.id);
    await transactionDone(tx);
  }

  async list(): Promise<SongSummary[]> {
    const tx = this.db.transaction(SONGS_STORE, 'readonly');
    const records = await requestToPromise(tx.objectStore(SONGS_STORE).getAll() as IDBRequest<unknown[]>);
    await transactionDone(tx);
    const summaries: SongSummary[] = [];
    for (const value of records) {
      try {
        summaries.push(summarize(decodeSongRecord(value)));
      } catch {
        // A record from a newer build (or a corrupted entry) is skipped rather than breaking the
        // whole library view; `load()` reports it properly if the player picks it.
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<LoadedSong | null> {
    const tx = this.db.transaction([SONGS_STORE, AUDIO_STORE], 'readonly');
    const record = await requestToPromise(tx.objectStore(SONGS_STORE).get(id) as IDBRequest<unknown>);
    const audio = await requestToPromise(
      tx.objectStore(AUDIO_STORE).get(id) as IDBRequest<StoredAudioBlob | undefined>,
    );
    await transactionDone(tx);
    if (record === undefined) return null;
    return { record: decodeSongRecord(record), audio: audio?.blob ?? null };
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction([SONGS_STORE, AUDIO_STORE], 'readwrite');
    tx.objectStore(SONGS_STORE).delete(id);
    tx.objectStore(AUDIO_STORE).delete(id);
    await transactionDone(tx);
  }

  async count(): Promise<number> {
    const tx = this.db.transaction(SONGS_STORE, 'readonly');
    const total = await requestToPromise(tx.objectStore(SONGS_STORE).count());
    await transactionDone(tx);
    return total;
  }

  close(): void {
    this.db.close();
  }
}

export class MemorySongStore implements SongStore {
  readonly kind = 'memory' as const;
  readonly persistent = false;
  private readonly records = new Map<string, string>();
  private readonly audio = new Map<string, StoredAudioBlob>();

  async save(record: SongRecord, audio: StoredAudioBlob | null): Promise<void> {
    const json = encodeSongRecord(record);
    this.records.set(record.id, json);
    if (audio) this.audio.set(record.id, audio);
    else this.audio.delete(record.id);
  }

  async list(): Promise<SongSummary[]> {
    const summaries: SongSummary[] = [];
    for (const json of this.records.values()) {
      try {
        summaries.push(summarize(decodeSongRecord(json)));
      } catch {
        /* see IndexedDbSongStore.list */
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(id: string): Promise<LoadedSong | null> {
    const json = this.records.get(id);
    if (json === undefined) return null;
    return { record: decodeSongRecord(json), audio: this.audio.get(id)?.blob ?? null };
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    this.audio.delete(id);
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  close(): void {
    this.records.clear();
    this.audio.clear();
  }
}

export interface SongLibrary {
  store: SongStore;
  /** Set when the library fell back to memory and will not survive a reload. */
  degradedReason: string | null;
}

/**
 * Open the library, falling back to memory storage when IndexedDB is unavailable. The caller is
 * expected to surface `degradedReason` rather than pretending persistence works.
 */
export async function openSongLibrary(factory?: IDBFactory): Promise<SongLibrary> {
  const indexedDb = factory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  if (!indexedDb) {
    return { store: new MemorySongStore(), degradedReason: 'This browser has no IndexedDB; songs last for this session only.' };
  }
  try {
    const store = await IndexedDbSongStore.open(indexedDb);
    return { store, degradedReason: null };
  } catch (error) {
    return {
      store: new MemorySongStore(),
      degradedReason: `IndexedDB could not be opened (${error instanceof Error ? error.message : String(error)}); songs last for this session only.`,
    };
  }
}
