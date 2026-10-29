'use strict';

const DRM_PATTERNS = [
  /#EXT-X-KEY/i,
  /SAMPLE-AES/i,
  /com\.widevine/i,
  /com\.apple\.fps/i,
  /com\.microsoft\.playready/i,
  /urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i, // Widevine UUID in DASH
  /ContentProtection/i,
  /FairPlay/i,
  /Widevine/i,
];

/**
 * @param {string} body
 * @returns {{ ok: boolean, reason?: string }}
 */
function inspectPlaylistForDrm(body) {
  if (!body || typeof body !== 'string') {
    return { ok: false, reason: 'empty playlist' };
  }
  for (const pattern of DRM_PATTERNS) {
    if (pattern.test(body)) {
      return { ok: false, reason: `DRM signal matched: ${pattern}` };
    }
  }
  if (!body.includes('#EXTM3U')) {
    return { ok: false, reason: 'not an HLS playlist' };
  }
  return { ok: true };
}

module.exports = { inspectPlaylistForDrm, DRM_PATTERNS };
