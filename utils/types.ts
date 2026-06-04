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

/** Everything needed to reconstruct an X GraphQL request from scratch. */
export interface GqlTemplate {
  queryId: string;
  operationName: string;
  features: string | null;
  fieldToggles: string | null;
  variables: Record<string, unknown>;
}
/** @deprecated alias — kept so existing imports compile. */
export type DetailTemplate = GqlTemplate;

export type PageMessage =
  | { source: 'cgx-page'; type: 'capture'; op: string; url: string; json: unknown }
  | { source: 'cgx-page'; type: 'gql-template'; op: string; template: GqlTemplate }
  | {
      source: 'cgx-page';
      type: 'fetch-more-result';
      requestId: number;
      ok: boolean;
      status?: number;
      error?: string;
    }
  | {
      source: 'cgx-page';
      type: 'op-result';
      requestId: number;
      ok: boolean;
      status?: number;
      error?: string;
      json?: unknown;
    };

export type ContentMessage =
  | { source: 'cgx-content'; type: 'ready' }
  | {
      source: 'cgx-content';
      type: 'restore-templates';
      templates: Record<string, GqlTemplate>;
    }
  | { source: 'cgx-content'; type: 'clear-template'; op: string }
  | { source: 'cgx-content'; type: 'fetch-more'; cursor: string; requestId: number }
  | { source: 'cgx-content'; type: 'fetch-detail'; tweetId: string; requestId: number }
  | {
      source: 'cgx-content';
      type: 'run-op';
      op: string;
      variables: Record<string, unknown>;
      requestId: number;
    };

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

export interface ApiToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ApiToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

/** Any other server-managed block (e.g. server_tool_use, web_search_tool_result)
 * that we round-trip back to the API verbatim. */
export interface ApiOpaqueBlock {
  type: string;
  [key: string]: unknown;
}

export type ContentBlock =
  | ApiTextBlock
  | ApiImageBlock
  | ApiToolUseBlock
  | ApiToolResultBlock
  | ApiOpaqueBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** A plain string, or content blocks (text/images/tool use/results). */
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

/** Content script → worker: result of executing a client-side tool. */
export interface ToolResultReply {
  type: 'tool-result';
  id: string;
  content: string;
}

/** Anything the panel sends to the worker over the port. */
export type PanelToWorker = RunRequest | ToolResultReply;

/** Request from a content script asking the worker to fetch + base64 images. */
export interface FetchImagesRequest {
  type: 'fetch-images';
  urls: string[];
}

/** A web search result / source for the inline cards + sources strip. */
export interface WebSource {
  url: string;
  title: string;
}

/** Token usage for a response, summed across any tool-loop turns. */
export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  /** Server-side web searches performed (Anthropic web_search) — billed per request. */
  webSearches?: number;
}

/** A tweet shown inside an X tool card. */
export interface ToolTweet {
  handle: string;
  text: string;
  url: string;
  likes: number | null;
}

/** A tool-call card rendered inline in a turn and persisted with it. */
export type ToolCard =
  | { kind: 'web'; query: string; running: boolean; results: WebSource[] }
  | { kind: 'x'; label: string; query?: string; tweets: ToolTweet[]; note?: string };

export type StreamMessage =
  | { type: 'delta'; text: string }
  | { type: 'status'; text: string }
  | { type: 'tool-exec'; id: string; name: string; input: unknown }
  | { type: 'web-search-start'; query: string }
  | { type: 'web-search-results'; query: string; results: WebSource[] }
  | { type: 'web-sources'; sources: WebSource[] }
  | { type: 'usage'; usage: UsageInfo }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ---- settings ----

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

/** Config for an OpenAI-compatible endpoint (OpenAI, OpenRouter, local, blackpilled…). */
export interface OpenAIConfig {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1 (no trailing slash)
  apiKey: string;
  model: string;
  models: string[]; // optional cache populated from /models
  /** Send chat_template_kwargs.enable_thinking=false (for Qwen/llama.cpp reasoning models). */
  disableThinking: boolean;
  /** Max output tokens for this endpoint. */
  maxTokens: number;
  /** Web search: off, OpenRouter's built-in plugin (no key), or a Tavily key. */
  webSearchMode: 'off' | 'openrouter' | 'tavily';
  tavilyKey: string;
}

export interface Settings {
  /** Which backend to use. 'anthropic' = native; 'openai' = any compatible endpoint. */
  provider: 'anthropic' | 'openai';
  authMode: 'oauth' | 'apikey';
  apiKey: string;
  model: string;
  openai: OpenAIConfig;
  maxReplies: number;
  webSearch: boolean;
  activeFetch: boolean;
  sendImages: boolean;
  /** Let Claude search X / fetch posts via the user's session (off by default). */
  xTools: boolean;
  oauth: OAuthTokens | null;
}
