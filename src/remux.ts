import { spawn, execFileSync, type ChildProcess } from 'child_process';
import type { Request, Response } from 'express';
import ffmpegStatic from 'ffmpeg-static';

let resolvedFfmpeg: string | null | undefined;

/** Prefer bundled ffmpeg-static, then PATH `ffmpeg`. */
export function resolveFfmpegPath(): string | null {
  if (resolvedFfmpeg !== undefined) return resolvedFfmpeg;
  if (ffmpegStatic) {
    try {
      execFileSync(ffmpegStatic, ['-version'], { stdio: 'ignore' });
      resolvedFfmpeg = ffmpegStatic;
      return resolvedFfmpeg;
    } catch {
      // fall through
    }
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    resolvedFfmpeg = 'ffmpeg';
    return resolvedFfmpeg;
  } catch {
    resolvedFfmpeg = null;
    return null;
  }
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

/**
 * Pipe ffmpeg remux (video HLS + audio HLS → MPEG-TS) to the HTTP response.
 * Caller must have already set that ffmpeg exists when audio is present.
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

export function remuxStreamUrl(baseUrl: string, productId: string, configPath?: string): string {
  const root = baseUrl.replace(/\/$/, '');
  if (configPath) return `${root}/${configPath}/remux/${productId}/stream.ts`;
  return `${root}/remux/${productId}/stream.ts`;
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
