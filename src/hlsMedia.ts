/** Parse HLS media playlists (VOD fMP4 and live TS). */

export interface MediaSegment {
  duration: number;
  url: string;
}

export interface ParsedMediaPlaylist {
  targetDuration: number;
  mediaSequence: number;
  playlistType?: string;
  endList: boolean;
  initUrl?: string;
  segments: MediaSegment[];
  /** Sum of EXTINF durations in seconds. */
  totalDuration: number;
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

export function parseMediaPlaylist(body: string): ParsedMediaPlaylist {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  let targetDuration = 6;
  let mediaSequence = 0;
  let playlistType: string | undefined;
  let endList = false;
  let initUrl: string | undefined;
  const segments: MediaSegment[] = [];
  let pendingDuration: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || targetDuration;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrs(line);
      if (attrs.URI) initUrl = attrs.URI;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const raw = line.slice('#EXTINF:'.length).split(',')[0];
      pendingDuration = Number(raw) || 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pendingDuration !== null) {
      segments.push({ duration: pendingDuration, url: line });
      pendingDuration = null;
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  return {
    targetDuration,
    mediaSequence,
    playlistType,
    endList,
    initUrl,
    segments,
    totalDuration,
  };
}

export function formatRuntimeMs(ms?: number, formatted?: string): string | undefined {
  if (formatted?.trim()) return formatted.trim();
  if (!ms || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return s ? `${h}h ${m}m` : m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s >= 30 ? `${m + 1} min` : `${m} min`;
  return `${s}s`;
}
