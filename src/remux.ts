import { spawn, execFileSync, type ChildProcess } from 'child_process';
import type { Request, Response } from 'express';

let ffmpegAvailable: boolean | null = null;

export function hasFfmpeg(): boolean {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
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
  const hdr = headerBlock(headers);

  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', headers['User-Agent'] || 'Mozilla/5.0'];

  if (audioUrl) {
    args.push('-headers', hdr, '-i', videoUrl, '-headers', hdr, '-i', audioUrl);
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c', 'copy');
  } else {
    args.push('-headers', hdr, '-i', videoUrl);
    args.push('-map', '0:v:0', '-c', 'copy');
  }

  // mpegts is widely playable by Stremio; copy avoids re-encode cost.
  args.push('-f', 'mpegts', 'pipe:1');

  let ff: ChildProcess;
  try {
    ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[remux] spawn failed', message);
    if (!res.headersSent) {
      res.status(500).type('text/plain').send('remux spawn failed');
    }
    return null;
  }

  res.status(200);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');

  if (!ff.stdout) {
    console.error('[remux] ffmpeg stdout missing');
    if (!res.headersSent) res.status(500).type('text/plain').send('remux stdout missing');
    return null;
  }
  ff.stdout.pipe(res);

  let stderrBuf = '';
  ff.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-2000);
  });

  const cleanup = () => {
    if (!ff.killed) {
      try {
        ff.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  ff.on('error', (err) => {
    console.error('[remux] ffmpeg error', err.message);
    cleanup();
    if (!res.writableEnded) res.end();
  });

  ff.on('close', (code, signal) => {
    if (code && code !== 0) {
      console.error('[remux] ffmpeg exited', { code, signal, stderr: stderrBuf.trim().slice(0, 500) });
    }
    if (!res.writableEnded) res.end();
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
