/** Parse Rally/Red Bull multivariant HLS masters (often demuxed A/V). */

export interface VideoRendition {
  bandwidth: number;
  width?: number;
  height?: number;
  url: string;
  audioGroup?: string;
  codecs?: string;
}

export interface AudioRendition {
  language: string;
  name: string;
  isDefault: boolean;
  autoSelect: boolean;
  groupId: string;
  url: string;
}

export interface ParsedMaster {
  demuxed: boolean;
  videos: VideoRendition[];
  audios: AudioRendition[];
}

function parseAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    attrs[m[1].toUpperCase()] = m[3] !== undefined ? m[3] : m[2];
  }
  return attrs;
}

function parseResolution(value: string | undefined): { width?: number; height?: number } {
  if (!value) return {};
  const m = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!m) return {};
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function parseMasterPlaylist(body: string): ParsedMaster {
  const lines = body.split(/\r?\n/);
  const videos: VideoRendition[] = [];
  const audios: AudioRendition[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrs(line);
      if ((attrs.TYPE || '').toUpperCase() !== 'AUDIO') continue;
      const uri = attrs.URI;
      if (!uri) continue;
      audios.push({
        language: (attrs.LANGUAGE || '').toLowerCase(),
        name: attrs.NAME || attrs.LANGUAGE || 'audio',
        isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES',
        autoSelect: (attrs.AUTOSELECT || '').toUpperCase() === 'YES',
        groupId: attrs['GROUP-ID'] || '',
        url: uri,
      });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttrs(line);
      let url = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (!next || next.startsWith('#')) continue;
        url = next;
        i = j;
        break;
      }
      if (!url) continue;
      const { width, height } = parseResolution(attrs.RESOLUTION);
      videos.push({
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        width,
        height,
        url,
        audioGroup: attrs.AUDIO,
        codecs: attrs.CODECS,
      });
    }
  }

  return {
    demuxed: audios.length > 0,
    videos,
    audios,
  };
}

/** Prefer ~720p to balance quality vs remux CPU/bandwidth. */
export function pickVideoRendition(
  videos: VideoRendition[],
  targetHeight = 720,
): VideoRendition | null {
  if (!videos.length) return null;
  const ranked = [...videos].sort((a, b) => {
    const ah = a.height ?? 0;
    const bh = b.height ?? 0;
    if (ah && bh) return Math.abs(ah - targetHeight) - Math.abs(bh - targetHeight);
    if (ah) return -1;
    if (bh) return 1;
    return a.bandwidth - b.bandwidth;
  });
  return ranked[0];
}

/** Prefer DEFAULT, then English, then first track (optionally matching audio group). */
export function pickAudioRendition(
  audios: AudioRendition[],
  audioGroup?: string,
): AudioRendition | null {
  if (!audios.length) return null;
  const inGroup = audioGroup ? audios.filter((a) => a.groupId === audioGroup) : audios;
  const pool = inGroup.length ? inGroup : audios;
  return (
    pool.find((a) => a.isDefault) ||
    pool.find((a) => a.language === 'en' || a.language.startsWith('en-')) ||
    pool.find((a) => a.autoSelect) ||
    pool[0]
  );
}
