// Shared types across the extension.

/** A parsed tweet, from either the GraphQL capture or the DOM fallback. */
export interface TweetData {
  id: string;
  name: string;
  handle: string;
  text: string;
  createdAt: string;
  likes: number | null;
  retweets: number | null;
  replyCount: number | null;
  quotes: number | null;
  views: string | null;
  media: { type: string; alt: string; url: string | null }[];
  quoted: TweetData | null;
  /** True when this came from scraping the rendered DOM instead of the network. */
  fromDom?: boolean;
}

/** Everything we know about one conversation (a focal tweet + its replies). */
export interface Conversation {
  main: TweetData | null;
  /** Keyed by tweet id, in X's relevance order as captured. */
  replies: Map<string, TweetData>;
  /** Cursor for the next page of replies, if X reported one. */
  bottomCursor: string | null;
}

// ---- window messages between the MAIN-world interceptor and the content script ----

/** Everything needed to reconstruct a TweetDetail GraphQL request from scratch. */
export interface DetailTemplate {
  queryId: string;
  operationName: string;
  features: string | null;
  fieldToggles: string | null;
  variables: Record<string, unknown>;
}

export type PageMessage =
  | { source: 'cgx-page'; type: 'capture'; op: string; url: string; json: unknown }
  | { source: 'cgx-page'; type: 'detail-template'; template: DetailTemplate }
  | {
      source: 'cgx-page';
      type: 'fetch-more-result';
      requestId: number;
      ok: boolean;
      status?: number;
      error?: string;
    };

export type ContentMessage =
  | { source: 'cgx-content'; type: 'ready' }
  | { source: 'cgx-content'; type: 'restore-template'; template: DetailTemplate }
  | { source: 'cgx-content'; type: 'clear-template' }
  | { source: 'cgx-content'; type: 'fetch-more'; cursor: string; requestId: number }
  | { source: 'cgx-content'; type: 'fetch-detail'; tweetId: string; requestId: number };

// ---- port messages between the content script and the background worker ----

export type ActionId = 'explain' | 'summarize' | 'factcheck';

export interface ApiTextBlock {
  type: 'text';
  text: string;
}

export interface ApiImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export type ContentBlock = ApiTextBlock | ApiImageBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** A plain string, or multimodal content blocks (text + images). */
  content: string | ContentBlock[];
}

export interface RunRequest {
  type: 'run';
  action: ActionId;
  /** 'tweet' = focused on a specific post; 'general' = standalone chat. */
  mode: 'tweet' | 'general';
  /** Full conversation so far. The first user message embeds the thread context. */
  messages: ChatMessage[];
}

/** Request from a content script asking the worker to fetch + base64 images. */
export interface FetchImagesRequest {
  type: 'fetch-images';
  urls: string[];
}

export type StreamMessage =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ---- settings ----

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface Settings {
  authMode: 'oauth' | 'apikey';
  apiKey: string;
  model: string;
  maxReplies: number;
  webSearch: boolean;
  activeFetch: boolean;
  sendImages: boolean;
  oauth: OAuthTokens | null;
}
