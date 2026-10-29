import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import ffmpegStatic from 'ffmpeg-static';
import { parseMediaPlaylist, type ParsedMediaPlaylist } from './hlsMedia';

let resolvedFfmpeg: string | null | undefined;

/**
 * Prefer system `ffmpeg` (Railpack apt / brew) over ffmpeg-static.
 * ffmpeg-static has been observed to SIGSEGV remuxing Rally HLS on Railway Linux.
 */
export function resolveFfmpegPath(): string | null {
  if (resolvedFfmpeg !== undefined) return resolvedFfmpeg;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    resolvedFfmpeg = 'ffmpeg';
    return resolvedFfmpeg;
  } catch {
    // fall through to bundled binary
  }
  if (ffmpegStatic) {
    try {
      execFileSync(ffmpegStatic, ['-version'], { stdio: 'ignore' });
      resolvedFfmpeg = ffmpegStatic;
      return resolvedFfmpeg;
    } catch {
      // fall through
    }
  }
  resolvedFfmpeg = null;
  return null;
}

export function hasFfmpeg(): boolean {
  return resolveFfmpegPath() !== null;
}

function headerBlock(headers: Record<string, string>): string {
  return (
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n'
  );
}

async function fetchBuffer(url: string, headers: Record<string, string>): Promise<Buffer> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url.slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchText(url: string, headers: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url.slice(0, 120)}`);
  return res.text();
}

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SEGMENT_CACHE = 48;

interface RemuxVodSession {
  key: string;
  headers: Record<string, string>;
  video: ParsedMediaPlaylist;
  audio: ParsedMediaPlaylist | null;
  videoInit?: Buffer;
  audioInit?: Buffer;
  lastAccess: number;
  segmentCache: Map<number, Buffer>;
  inflight: Map<number, Promise<Buffer>>;
}

const vodSessions = new Map<string, RemuxVodSession>();

function touch(session: RemuxVodSession): void {
  session.lastAccess = Date.now();
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [key, session] of vodSessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) vodSessions.delete(key);
  }
}

function sessionKey(productId: string, videoUrl: string, audioUrl: string | null): string {
  return `${productId}|${videoUrl}|${audioUrl || ''}`;
}

async function getVodSession(opts: {
  productId: string;
  videoUrl: string;
  audioUrl: string | null;
  headers: Record<string, string>;
}): Promise<RemuxVodSession> {
  pruneSessions();
  const key = sessionKey(opts.productId, opts.videoUrl, opts.audioUrl);
  const existing = vodSessions.get(key);
  if (existing) {
    touch(existing);
    return existing;
  }

  const videoBody = await fetchText(opts.videoUrl, opts.headers);
  const video = parseMediaPlaylist(videoBody);
  if (!video.segments.length) throw new Error('video playlist has no segments');

  let audio: ParsedMediaPlaylist | null = null;
  if (opts.audioUrl) {
    const audioBody = await fetchText(opts.audioUrl, opts.headers);
    audio = parseMediaPlaylist(audioBody);
  }

  const session: RemuxVodSession = {
    key,
    headers: opts.headers,
    video,
    audio,
    lastAccess: Date.now(),
    segmentCache: new Map(),
    inflight: new Map(),
  };
  vodSessions.set(key, session);
  return session;
}

function cacheSegment(session: RemuxVodSession, index: number, buf: Buffer): void {
  session.segmentCache.set(index, buf);
  while (session.segmentCache.size > MAX_SEGMENT_CACHE) {
    const oldest = session.segmentCache.keys().next().value;
    if (oldest === undefined) break;
    session.segmentCache.delete(oldest);
  }
}

async function ensureInits(session: RemuxVodSession): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (session.video.initUrl && !session.videoInit) {
    jobs.push(
      fetchBuffer(session.video.initUrl, session.headers).then((buf) => {
        session.videoInit = buf;
      }),
    );
  }
  if (session.audio?.initUrl && !session.audioInit) {
    jobs.push(
      fetchBuffer(session.audio.initUrl, session.headers).then((buf) => {
        session.audioInit = buf;
      }),
    );
  }
  if (jobs.length) await Promise.all(jobs);
}

function remuxLocalFilesToTs(videoPath: string, audioPath: string | null, tsOffsetSec: number): Promise<Buffer> {
  const bin = resolveFfmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg not available'));

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
  ];
  if (audioPath) {
    args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');
  } else {
    args.push('-map', '0:v:0');
  }
  args.push(
    '-c',
    'copy',
    '-muxdelay',
    '0',
    '-muxpreload',
    '0',
    '-output_ts_offset',
    String(Math.max(0, tsOffsetSec)),
    '-f',
    'mpegts',
    'pipe:1',
  );

  return new Promise((resolve, reject) => {
    const ff = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    ff.stdout?.on('data', (c: Buffer) => chunks.push(c));
    ff.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(-1000);
    });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(stderr.trim() || `ffmpeg segment remux failed code=${code}`));
    });
  });
}

async function buildSegmentTs(session: RemuxVodSession, index: number): Promise<Buffer> {
  const cached = session.segmentCache.get(index);
  if (cached) return cached;

  const inflight = session.inflight.get(index);
  if (inflight) return inflight;

  const job = (async () => {
    const vSeg = session.video.segments[index];
    if (!vSeg) throw new Error(`segment ${index} out of range`);

    await ensureInits(session);

    const aSeg = session.audio?.segments[index];
    const tmp = mkdtempSync(join(tmpdir(), 'rally-remux-'));
    try {
      const videoPath = join(tmp, 'v.mp4');
      const vBody = await fetchBuffer(vSeg.url, session.headers);
      writeFileSync(videoPath, session.videoInit ? Buffer.concat([session.videoInit, vBody]) : vBody);

      let audioPath: string | null = null;
      if (session.audio && aSeg) {
        audioPath = join(tmp, 'a.mp4');
        const aBody = await fetchBuffer(aSeg.url, session.headers);
        writeFileSync(audioPath, session.audioInit ? Buffer.concat([session.audioInit, aBody]) : aBody);
      }

      let tsOffset = 0;
      for (let i = 0; i < index; i++) tsOffset += session.video.segments[i]?.duration || 0;

      const ts = await remuxLocalFilesToTs(videoPath, audioPath, tsOffset);
      cacheSegment(session, index, ts);
      return ts;
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  })();

  session.inflight.set(index, job);
  try {
    return await job;
  } finally {
    session.inflight.delete(index);
  }
}

/** Build a muxed VOD HLS playlist so Stremio gets duration + seekable segments. */
export function buildMuxedVodPlaylist(segmentCount: number, targetDuration: number, durations: number[]): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(targetDuration))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  for (let i = 0; i < segmentCount; i++) {
    const dur = durations[i] ?? targetDuration;
    lines.push(`#EXTINF:${dur.toFixed(3)},`);
    lines.push(`seg/${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

export async function handleVodPlaylist(opts: {
  productId: string;
  videoUrl: string;
  audioUrl: string | null;
  headers: Record<string, string>;
  res: Response;
}): Promise<void> {
  const session = await getVodSession(opts);
  touch(session);
  const count = session.audio
    ? Math.min(session.video.segments.length, session.audio.segments.length)
    : session.video.segments.length;
  const durations = session.video.segments.slice(0, count).map((s) => s.duration);
  const body = buildMuxedVodPlaylist(count, session.video.targetDuration, durations);
  opts.res.status(200);
  opts.res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  opts.res.setHeader('Cache-Control', 'no-store');
  opts.res.send(body);
}

export async function handleVodSegment(opts: {
  productId: string;
  videoUrl: string;
  audioUrl: string | null;
  headers: Record<string, string>;
  index: number;
  res: Response;
}): Promise<void> {
  const session = await getVodSession(opts);
  touch(session);
  const count = session.audio
    ? Math.min(session.video.segments.length, session.audio.segments.length)
    : session.video.segments.length;
  if (opts.index < 0 || opts.index >= count) {
    opts.res.status(404).type('text/plain').send('segment out of range');
    return;
  }
  const buf = await buildSegmentTs(session, opts.index);
  opts.res.status(200);
  opts.res.setHeader('Content-Type', 'video/mp2t');
  opts.res.setHeader('Content-Length', String(buf.length));
  opts.res.setHeader('Cache-Control', 'public, max-age=60');
  opts.res.send(buf);
}

/**
 * Pipe ffmpeg remux (video HLS + audio HLS → MPEG-TS) to the HTTP response.
 * Used for live (non-seekable) demuxed streams.
 */
export function pipeRemuxMpegTs(opts: {
  videoUrl: string;
  audioUrl: string | null;
  headers: Record<string, string>;
  req: Request;
  res: Response;
}): ChildProcess | null {
  const { videoUrl, audioUrl, headers, req, res } = opts;
  const bin = resolveFfmpegPath();
  if (!bin) {
    if (!res.headersSent) {
      res.status(503).type('text/plain').send('ffmpeg not available');
    }
    return null;
  }

  const hdr = headerBlock(headers);

  // Start outputting ASAP; don't wait to fully probe long VOD playlists.
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-user_agent',
    headers['User-Agent'] || 'Mozilla/5.0',
    '-probesize',
    '32k',
    '-analyzeduration',
    '0',
  ];

  if (audioUrl) {
    args.push('-headers', hdr, '-i', videoUrl, '-headers', hdr, '-i', audioUrl);
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c', 'copy');
  } else {
    args.push('-headers', hdr, '-i', videoUrl);
    args.push('-map', '0:v:0', '-c', 'copy');
  }

  // mpegts is widely playable by Stremio; copy avoids re-encode cost.
  args.push('-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1');

  let ff: ChildProcess;
  try {
    ff = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[remux] spawn failed', message);
    if (!res.headersSent) {
      res.status(500).type('text/plain').send('remux spawn failed');
    }
    return null;
  }

  if (!ff.stdout) {
    console.error('[remux] ffmpeg stdout missing');
    if (!res.headersSent) res.status(500).type('text/plain').send('remux stdout missing');
    return null;
  }

  let stderrBuf = '';
  ff.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
  });

  let bytesOut = 0;
  ff.stdout.on('data', (chunk: Buffer) => {
    bytesOut += chunk.length;
    if (bytesOut === chunk.length) console.log('[remux] first bytes', chunk.length);
  });

  // Do not kill on req 'close' — for GET that fires as soon as the request is read,
  // which aborted ffmpeg before any bytes (empty 200). Only abort when the client drops.
  const cleanup = (reason: string) => {
    if (!ff.killed) {
      console.log('[remux] cleanup', reason, `bytes=${bytesOut}`);
      try {
        ff.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  };

  req.on('aborted', () => cleanup('req-aborted'));
  res.on('close', () => {
    if (!res.writableEnded) cleanup('res-close');
  });

  res.status(200);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');
  // Disable Express buffering so Stremio gets TS packets as ffmpeg produces them.
  res.flushHeaders?.();
  ff.stdout.pipe(res);

  ff.on('error', (err) => {
    console.error('[remux] ffmpeg error', err.message);
    cleanup('ffmpeg-error');
    if (!res.writableEnded) res.end();
  });

  ff.on('close', (code, signal) => {
    if (bytesOut === 0) {
      const detail = stderrBuf.trim().slice(0, 800) || `code=${code} signal=${signal}`;
      console.error('[remux] ffmpeg exited with no output', detail);
    } else if (code && code !== 0) {
      console.error('[remux] ffmpeg exited', {
        code,
        signal,
        bytesOut,
        stderr: stderrBuf.trim().slice(0, 500),
      });
    } else {
      console.log('[remux] done', { bytesOut, code });
    }
  });

  return ff;
}

export function publicBaseUrl(port: number): string {
  const explicit = process.env.ADDON_BASE_URL || process.env.PUBLIC_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) {
    const host = railway.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${host}`;
  }
  return `http://127.0.0.1:${port}`;
}

/** Live / progressive MPEG-TS remux URL. */
export function remuxStreamUrl(baseUrl: string, productId: string, configPath?: string): string {
  const root = baseUrl.replace(/\/$/, '');
  if (configPath) return `${root}/${configPath}/remux/${productId}/stream.ts`;
  return `${root}/remux/${productId}/stream.ts`;
}

/** Seekable VOD remux playlist URL. */
export function remuxPlaylistUrl(baseUrl: string, productId: string, configPath?: string): string {
  const root = baseUrl.replace(/\/$/, '');
  if (configPath) return `${root}/${configPath}/remux/${productId}/index.m3u8`;
  return `${root}/remux/${productId}/index.m3u8`;
}

export function encodeConfigPath(config: {
  authToken?: string;
  locale?: string;
  country?: string;
}): string | undefined {
  const payload: Record<string, string> = {};
  if (config.authToken) payload.authToken = config.authToken;
  if (config.locale) payload.locale = config.locale;
  if (config.country) payload.country = config.country;
  if (!Object.keys(payload).length) return undefined;
  return encodeURIComponent(JSON.stringify(payload));
}

export function parseConfigPath(raw: string | undefined): {
  authToken?: string;
  locale?: string;
  country?: string;
} {
  if (!raw) return {};
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    return {
      authToken: typeof parsed.authToken === 'string' ? parsed.authToken : undefined,
      locale: typeof parsed.locale === 'string' ? parsed.locale : undefined,
      country: typeof parsed.country === 'string' ? parsed.country : undefined,
    };
  } catch {
    return {};
  }
}
