import { indexedDBCache } from '@/lib/indexedDBCache';

const inflight = new Map<string, Promise<unknown>>();
const memory = new Map<string, { at: number; ttl: number; data: unknown }>();

export const TTL = {
  seconds: (value: number) => value * 1000,
  minutes: (value: number) => value * 60_000,
  hours: (value: number) => value * 3_600_000,
};

export function cacheKey(url: string): string {
  return url
    .replace(/([?&])(_|cb|callback)=[^&]*/g, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');
}

function persistKey(key: string) {
  return `market:${key}`;
}

async function readPersisted<T>(key: string): Promise<T | null> {
  if (typeof window === 'undefined') return null;
  try {
    return await indexedDBCache.get<T>(persistKey(key));
  } catch {
    return null;
  }
}

async function writePersisted(key: string, ttl: number, data: unknown) {
  if (typeof window === 'undefined') return;
  try {
    await indexedDBCache.set(persistKey(key), data, ttl);
  } catch {
    // ignore persistence failures
  }
}

async function deletePersisted(key: string) {
  if (typeof window === 'undefined') return;
  try {
    await indexedDBCache.delete(persistKey(key));
  } catch {
    // ignore delete failures
  }
}

export async function cached<T>(
  key: string,
  ttl: number,
  persist: boolean,
  loader: () => Promise<T>,
  options?: { force?: boolean }
): Promise<T> {
  const force = options?.force === true;
  if (force) {
    memory.delete(key);
    inflight.delete(key);
    if (persist) await deletePersisted(key);
  }
  const hit = memory.get(key);
  if (!force && hit && Date.now() - hit.at < hit.ttl) return hit.data as T;
  if (persist) {
    const stored = await readPersisted<T>(key);
    if (stored != null) {
      memory.set(key, { at: Date.now(), ttl, data: stored });
      return stored;
    }
  }
  const pending = inflight.get(key);
  if (!force && pending) return pending as Promise<T>;

  const request = loader()
    .then(async (data) => {
      memory.set(key, { at: Date.now(), ttl, data });
      const empty = Array.isArray(data) && data.length === 0;
      if (persist && !empty) await writePersisted(key, ttl, data);
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

function withCallback(url: string, name: string): string {
  if (/[?&]cb=/.test(url)) return url.replace(/([?&]cb=)[^&]*/, `$1${name}`);
  if (/[?&]callback=/.test(url)) return url.replace(/([?&]callback=)[^&]*/, `$1${name}`);
  return `${url}${url.includes('?') ? '&' : '?'}cb=${name}`;
}

function parseJsonOrJsonp<T>(payload: unknown): T {
  if (payload instanceof ArrayBuffer) {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(payload));
    return parseJsonOrJsonp<T>(text);
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(payload)) {
    const view = payload as ArrayBufferView;
    const text = new TextDecoder('utf-8').decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return parseJsonOrJsonp<T>(text);
  }
  if (payload && typeof payload === 'object') return payload as T;
  const text = typeof payload === 'string' ? payload : String(payload ?? '');
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('empty payload');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed) as T;
  }
  const left = trimmed.indexOf('(');
  const right = trimmed.lastIndexOf(')');
  if (left === -1 || right === -1 || right <= left) {
    throw new Error('invalid jsonp payload');
  }
  return JSON.parse(trimmed.slice(left + 1, right)) as T;
}

function stripJsonpCallback(url: string): string {
  return url
    .replace(/([?&])cb=[^&]*/g, '$1')
    .replace(/([?&])callback=[^&]*/g, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');
}

async function foxRequestJson<T>(url: string): Promise<T> {
  if (typeof window === 'undefined' || typeof window.foxAgentCrossRequest !== 'function') {
    throw new Error('foxAgentCrossRequest unavailable');
  }
  const payload = await new Promise<unknown>((resolve, reject) => {
    window.foxAgentCrossRequest?.({
      url: stripJsonpCallback(url),
      method: 'GET',
      success(body) {
        resolve(body);
      },
      error(error) {
        reject(error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error)));
      },
    });
  });
  return parseJsonOrJsonp<T>(payload);
}

export function jsonp<T>(url: string, timeout = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('jsonp requires browser'));
      return;
    }
    const cbName = `__em_${Math.random().toString(36).slice(2, 10)}`;
    const script = document.createElement('script');
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`jsonp timeout: ${url}`));
    }, timeout);

    const cleanup = () => {
      window.clearTimeout(timer);
      delete (window as unknown as Record<string, unknown>)[cbName];
      script.remove();
    };

    (window as unknown as Record<string, (data: T) => void>)[cbName] = (data: T) => {
      cleanup();
      resolve(data);
    };
    script.src = withCallback(url, cbName);
    script.onerror = () => {
      cleanup();
      reject(new Error(`jsonp script load error: ${url}`));
    };
    document.head.appendChild(script);
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-cache',
    headers: { Accept: 'application/json,text/javascript,*/*' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function isEastmoney(url: string) {
  return /eastmoney\.com/i.test(url);
}

export function marketGet<T>(url: string, ttl = TTL.seconds(30), persist = false): Promise<T> {
  return cached(cacheKey(url), ttl, persist, async () => {
    if (isEastmoney(url)) {
      try {
        return await foxRequestJson<T>(url);
      } catch {
        return jsonp<T>(url);
      }
    }
    try {
      return await fetchJson<T>(url);
    } catch {
      return jsonp<T>(url);
    }
  });
}

export function marketGetForce<T>(url: string, ttl = TTL.seconds(30), persist = false): Promise<T> {
  return cached(
    cacheKey(url),
    ttl,
    persist,
    async () => {
      if (isEastmoney(url)) {
        try {
          return await foxRequestJson<T>(url);
        } catch {
          return jsonp<T>(url);
        }
      }
      try {
        return await fetchJson<T>(url);
      } catch {
        return jsonp<T>(url);
      }
    },
    { force: true }
  );
}

export async function clearMarketCache(pattern = ''): Promise<void> {
  for (const key of [...memory.keys()]) {
    if (!pattern || key.includes(pattern)) {
      memory.delete(key);
      inflight.delete(key);
    }
  }
  if (typeof window !== 'undefined') {
    await indexedDBCache.clearPattern(`market:${pattern}`);
  }
}

export async function mapBatches<T, R>(items: T[], size: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    const chunk = await Promise.all(items.slice(index, index + size).map(mapper));
    output.push(...chunk);
  }
  return output;
}
