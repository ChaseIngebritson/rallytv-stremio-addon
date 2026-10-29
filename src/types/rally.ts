/** Addon user config (Stremio configure URL / settings). */
export interface AddonConfig {
  authToken?: string;
  locale?: string;
  country?: string;
}

export interface AnonymousSession {
  token: string;
  uid?: string;
  country: string;
  expiresAt: number;
}

export interface RallyBadge {
  value: string;
  type: string;
  display?: string;
  show_time?: boolean;
}

export interface RallyMediaResource {
  url: string;
  orientation?: string;
}

export type RallyMediaResources = Partial<
  Record<
    | 'rbtv_background_banner'
    | 'rbtv_background_landscape'
    | 'rbtv_background_portrait'
    | 'rbtv_background_square'
    | 'rbtv_display_art_banner'
    | 'rbtv_display_art_landscape'
    | 'rbtv_display_art_portrait'
    | 'rbtv_display_art_square'
    | 'rbtv_cover_art_portrait'
    | 'rbtv_title_treatment'
    | 'short_preview_mp4_high',
    RallyMediaResource
  >
>;

export interface RallyCollectionStub {
  id: string;
}

/** Shared fields on search items, collection cards, and product payloads. */
export interface RallyEntity {
  id: string;
  title?: string;
  subheading?: string;
  short_description?: string;
  long_description?: string;
  type?: string;
  content_type?: string;
  playable?: boolean;
  duration?: number;
  formatted_duration?: string;
  year?: number;
  tags?: string[];
  share_url?: string;
  start_time?: string;
  end_time?: string;
  show_time?: boolean;
  content_entitlements?: string[];
  resources?: string[];
  media_resources?: RallyMediaResources;
  badges?: RallyBadge[];
  header_badges?: RallyBadge[];
  score?: number;
  status?: string;
  maturity?: string;
  immersive?: boolean;
}

export interface RallyProduct extends RallyEntity {
  collections?: RallyCollectionStub[];
  header_type?: string;
}

export interface RallyDynamicProduct {
  id: string;
  links?: Array<{ id: string; label: string; type?: string; action?: string; icon?: string }>;
  badges?: RallyBadge[];
  header_badges?: RallyBadge[];
  start_time?: string;
  end_time?: string;
  show_time?: boolean;
  default_live_program?: string;
  display_countdown?: boolean;
  favorite_permission?: string;
}

export interface RallyCollectionMeta {
  total?: number;
  next?: string;
  limit?: number;
  offset?: number;
}

export interface RallyCollection {
  id: string;
  label?: string;
  type?: string;
  list_type?: string;
  category?: string;
  meta?: RallyCollectionMeta;
  cards?: RallyEntity[];
}

export interface RallySearchCollection {
  label?: string;
  short_label?: string;
  collection_type?: string;
  item_type?: string;
  type?: string;
  meta?: RallyCollectionMeta;
  items?: RallyEntity[];
}

export interface RallySearchResponse {
  label?: string;
  id?: string;
  title?: string;
  collections?: RallySearchCollection[];
}

export type EventCatalogKey = 'featured' | 'upcoming' | 'wrc' | 'erc';

export interface PlayableStream {
  url: string;
  headers: Record<string, string>;
  live: boolean;
  /**
   * When the master is demuxed (separate AUDIO renditions), Stremio cannot play it.
   * VOD: addon remuxes to seekable muxed HLS; live: progressive MPEG-TS pipe.
   */
  remux?: {
    videoUrl: string;
    audioUrl: string | null;
  };
}

export class RallyError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'RallyError';
    this.code = code;
  }
}

export function isRallyError(err: unknown): err is RallyError {
  return err instanceof RallyError || (err instanceof Error && 'code' in err);
}
