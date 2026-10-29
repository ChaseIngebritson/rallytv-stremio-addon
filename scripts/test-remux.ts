import { spawn } from 'child_process';
import * as rally from '../src/rallytv';
import { resolveFfmpegPath } from '../src/remux';

async function main(): Promise<void> {
  const productId = process.argv[2] || '0619a737-dffe-408e-8102-dd37ec7dd5a4';
  const playable = await rally.resolvePlayableStream(productId, {
    authToken: process.env.RALLYTV_AUTH_TOKEN || '',
  });
  if (!playable.remux?.videoUrl || !playable.remux.audioUrl) {
    throw new Error('no remux sources');
  }
  const bin = resolveFfmpegPath();
  if (!bin) throw new Error('no ffmpeg');
  console.log('ffmpeg', bin);
  console.log('video', playable.remux.videoUrl.slice(0, 120));
  const hdr =
    Object.entries(playable.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n';
  const out = '/tmp/local-remux-test.ts';
  const args = [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-headers',
    hdr,
    '-i',
    playable.remux.videoUrl,
    '-headers',
    hdr,
    '-i',
    playable.remux.audioUrl,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c',
    'copy',
    '-t',
    '3',
    '-f',
    'mpegts',
    out,
  ];
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(bin, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    ff.on('error', reject);
    ff.on('close', (code, signal) => {
      console.log('exit', { code, signal });
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed code=${code} signal=${signal}`));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
