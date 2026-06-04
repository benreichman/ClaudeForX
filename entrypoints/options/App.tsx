import { useEffect, useState } from 'react';
import { buildAuthorizeUrl, exchangeCode, generatePkce } from '@/utils/oauth';
import { DEFAULT_SETTINGS, MODELS, getSettings, saveSettings } from '@/utils/settings';
import type { OpenAIConfig, Settings } from '@/utils/types';

type OAuthStep = 'idle' | 'waiting-for-code' | 'exchanging';

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [oauthStep, setOauthStep] = useState<OAuthStep>('idle');
  const [pastedCode, setPastedCode] = useState('');
  const [verifier, setVerifier] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [primed, setPrimed] = useState({ tweets: false, search: false, profiles: false });
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
    void browser.storage.local.get('gqlTemplates').then((r) => {
      const t = (r.gqlTemplates ?? {}) as Record<string, unknown>;
      setPrimed({
        tweets: !!t.TweetDetail,
        search: !!t.SearchTimeline,
        profiles: !!t.UserByScreenName && !!t.UserTweets,
      });
    });
  }, []);

  // Persist a patch and mirror it into local state.
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void saveSettings(patch);
  };

  const startConnect = async () => {
    setNotice(null);
    const pkce = await generatePkce();
    setVerifier(pkce.verifier);
    setOauthStep('waiting-for-code');
    window.open(buildAuthorizeUrl(pkce), '_blank');
  };

  const finishConnect = async () => {
    setOauthStep('exchanging');
    setNotice(null);
    try {
      const tokens = await exchangeCode(pastedCode, verifier);
      update({ oauth: tokens, authMode: 'oauth' });
      setOauthStep('idle');
      setPastedCode('');
      setNotice({ kind: 'ok', text: 'Connected! Your Claude subscription is ready to use.' });
    } catch (e) {
      setOauthStep('waiting-for-code');
      setNotice({ kind: 'err', text: (e as Error).message });
    }
  };

  const disconnect = () => {
    update({ oauth: null });
    setNotice({ kind: 'ok', text: 'Disconnected.' });
  };

  const updateOpenAI = (patch: Partial<OpenAIConfig>) => {
    update({ openai: { ...settings.openai, ...patch } });
  };

  // Request host permission for the configured endpoint, then list its models.
  const testOpenAI = async () => {
    setNotice(null);
    const base = settings.openai.baseUrl.trim().replace(/\/$/, '');
    if (!base) {
      setNotice({ kind: 'err', text: 'Enter a base URL first.' });
      return;
    }
    let origin: string;
    try {
      origin = new URL(base).origin;
    } catch {
      setNotice({ kind: 'err', text: 'That base URL is not valid.' });
      return;
    }
    setTesting(true);
    try {
      const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        setNotice({ kind: 'err', text: 'Permission to reach that endpoint was denied.' });
        return;
      }
      const headers: Record<string, string> = {};
      if (settings.openai.apiKey) headers.authorization = `Bearer ${settings.openai.apiKey}`;
      const res = await fetch(`${base}/models`, { headers });
      if (!res.ok) {
        setNotice({
          kind: 'err',
          text: `Access granted, but /models returned ${res.status}. You can still type a model id manually.`,
        });
        return;
      }
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
      updateOpenAI({ models: ids, model: settings.openai.model || ids[0] || '' });
      setNotice({ kind: 'ok', text: `Connected — found ${ids.length} model${ids.length === 1 ? '' : 's'}.` });
    } catch (e) {
      setNotice({ kind: 'err', text: `Couldn't reach the endpoint: ${(e as Error).message}` });
    } finally {
      setTesting(false);
    }
  };

  if (!loaded) return null;

  const connected = Boolean(settings.oauth?.refreshToken);

  return (
    <main className="page">
      <h1>
        <span className="coral">✳</span> Claude for X
      </h1>
      <p className="subtitle">Claude (or any model) for X — a Grok-style sidebar, but yours.</p>

      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

      <section>
        <h2>Provider</h2>
        <label className="radio">
          <input
            type="radio"
            name="provider"
            checked={settings.provider === 'anthropic'}
            onChange={() => update({ provider: 'anthropic' })}
          />
          <div>
            <strong>Anthropic (Claude)</strong>
            <p>Native Claude — subscription or API key. Full tools + web search.</p>
          </div>
        </label>
        <label className="radio">
          <input
            type="radio"
            name="provider"
            checked={settings.provider === 'openai'}
            onChange={() => update({ provider: 'openai' })}
          />
          <div>
            <strong>OpenAI-compatible endpoint</strong>
            <p>
              Any OpenAI-style API — OpenRouter, Groq, local llama.cpp/Ollama,
              blackpilled.ai/api/v1, etc. Models may be uncensored; that's your call.
            </p>
          </div>
        </label>
      </section>

      {settings.provider === 'anthropic' && (
      <section>
        <h2>Billing &amp; authentication</h2>
        <label className="radio">
          <input
            type="radio"
            name="authMode"
            checked={settings.authMode === 'oauth'}
            onChange={() => update({ authMode: 'oauth' })}
          />
          <div>
            <strong>Claude subscription (Pro / Max)</strong>
            <p>
              Sign in with your Claude account and use your subscription instead of API
              credits. <em>Unofficial:</em> this rides the Claude Code OAuth flow — it works
              today, but it's a gray area in Anthropic's terms and could stop working.
            </p>
          </div>
        </label>
        <label className="radio">
          <input
            type="radio"
            name="authMode"
            checked={settings.authMode === 'apikey'}
            onChange={() => update({ authMode: 'apikey' })}
          />
          <div>
            <strong>Anthropic API key</strong>
            <p>Pay-per-use via console.anthropic.com. The officially supported way.</p>
          </div>
        </label>

        {settings.authMode === 'oauth' && (
          <div className="authbox">
            {connected ? (
              <div className="row">
                <span className="pill ok">Connected</span>
                <button className="secondary" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            ) : oauthStep === 'idle' ? (
              <button className="primary" onClick={() => void startConnect()}>
                Connect Claude account
              </button>
            ) : (
              <div className="connect-flow">
                <p>
                  1. Approve access in the tab that just opened.
                  <br />
                  2. Copy the code it shows you and paste it here:
                </p>
                <div className="row">
                  <input
                    type="text"
                    placeholder="Paste code (looks like xxxx#yyyy)"
                    value={pastedCode}
                    onChange={(e) => setPastedCode(e.target.value)}
                  />
                  <button
                    className="primary"
                    disabled={!pastedCode.trim() || oauthStep === 'exchanging'}
                    onClick={() => void finishConnect()}
                  >
                    {oauthStep === 'exchanging' ? 'Connecting…' : 'Finish'}
                  </button>
                </div>
                <button className="linklike" onClick={() => void startConnect()}>
                  Reopen the sign-in page
                </button>
              </div>
            )}
          </div>
        )}

        {settings.authMode === 'apikey' && (
          <div className="authbox">
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                placeholder="sk-ant-api03-…"
                value={settings.apiKey}
                onChange={(e) => update({ apiKey: e.target.value.trim() })}
              />
            </label>
          </div>
        )}
      </section>
      )}

      {settings.provider === 'openai' && (
        <section>
          <h2>OpenAI-compatible endpoint</h2>
          <div className="authbox">
            <label className="field">
              <span>Base URL</span>
              <input
                type="text"
                placeholder="https://openrouter.ai/api/v1"
                value={settings.openai.baseUrl}
                onChange={(e) => updateOpenAI({ baseUrl: e.target.value.trim() })}
              />
            </label>
            <label className="field">
              <span>API key</span>
              <input
                type="password"
                placeholder="sk-… (blank for local servers)"
                value={settings.openai.apiKey}
                onChange={(e) => updateOpenAI({ apiKey: e.target.value.trim() })}
              />
            </label>
            <label className="field">
              <span>Model</span>
              <input
                type="text"
                placeholder="e.g. blackpilled-35b, openai/gpt-4o-mini"
                value={settings.openai.model}
                onChange={(e) => updateOpenAI({ model: e.target.value.trim() })}
              />
            </label>
            <label className="field">
              <span>Max output tokens</span>
              <input
                type="number"
                min={256}
                max={32000}
                step={256}
                value={settings.openai.maxTokens}
                onChange={(e) => updateOpenAI({ maxTokens: Number(e.target.value) || 4096 })}
              />
            </label>
            <label className="field">
              <span>Web search</span>
              <select
                value={settings.openai.webSearchMode}
                onChange={(e) =>
                  updateOpenAI({ webSearchMode: e.target.value as 'off' | 'openrouter' | 'tavily' })
                }
              >
                <option value="off">Off</option>
                <option value="openrouter">OpenRouter built-in (no key)</option>
                <option value="tavily">Tavily API key</option>
              </select>
            </label>
            {settings.openai.webSearchMode === 'tavily' && (
              <label className="field">
                <span>Tavily API key</span>
                <input
                  type="password"
                  placeholder="tvly-…"
                  value={settings.openai.tavilyKey}
                  onChange={(e) => updateOpenAI({ tavilyKey: e.target.value.trim() })}
                />
              </label>
            )}
            <p className="hint">
              <strong>OpenRouter</strong>: uses its built-in web plugin — no extra key, bills
              your OpenRouter credits. <strong>Tavily</strong>: free-tier search (tavily.com);
              the model calls it as a tool and sources show under the answer. Either way, web
              search needs a tool-capable model.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.openai.disableThinking}
                onChange={(e) => updateOpenAI({ disableThinking: e.target.checked })}
              />
              <div>
                <strong>Disable model thinking</strong>
                <p>
                  For reasoning models (e.g. blackpilled-35b / Qwen on llama.cpp) that
                  stream chain-of-thought into <code>reasoning_content</code> and leave
                  the answer empty. Sends <code>chat_template_kwargs.enable_thinking=false</code>.
                  Leave OFF for OpenAI / OpenRouter.
                </p>
              </div>
            </label>
            <div className="row">
              <button className="primary" disabled={testing} onClick={() => void testOpenAI()}>
                {testing ? 'Connecting…' : 'Test & grant access'}
              </button>
              {settings.openai.models.length > 0 && (
                <span className="pill ok">{settings.openai.models.length} models</span>
              )}
            </div>
            <p className="hint">
              Grants the extension permission to reach that origin, then lists its models.
              X tools use this model's function calling when enabled; web search stays
              Anthropic-only.
            </p>
          </div>
        </section>
      )}

      {settings.provider === 'anthropic' && (
        <section>
          <h2>Model</h2>
          <select value={settings.model} onChange={(e) => update({ model: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </section>
      )}

      <section>
        <h2>Context</h2>
        <label className="field">
          <span>Max replies to include ({settings.maxReplies})</span>
          <input
            type="range"
            min={10}
            max={150}
            step={10}
            value={settings.maxReplies}
            onChange={(e) => update({ maxReplies: Number(e.target.value) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.activeFetch}
            onChange={(e) => update({ activeFetch: e.target.checked })}
          />
          <div>
            <strong>Actively fetch more replies</strong>
            <p>
              Page through replies the same way scrolling would, instead of only using
              what's already loaded. Turn off if you want the extension to be purely
              passive.
            </p>
          </div>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.sendImages}
            onChange={(e) => update({ sendImages: e.target.checked })}
          />
          <div>
            <strong>Send images to Claude</strong>
            <p>
              Attach a post's images so Claude can actually see them, not just their alt
              text. Up to 4 images per post. (Adds image tokens on API-key mode; free on
              subscription.)
            </p>
          </div>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.webSearch}
            onChange={(e) => update({ webSearch: e.target.checked })}
          />
          <div>
            <strong>Web search</strong>
            <p>
              Lets Claude search the web for current info (news, recent events, anything
              past training). Available in every mode. (Billed as tool use on API-key mode.)
            </p>
          </div>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.xTools}
            onChange={(e) => update({ xTools: e.target.checked })}
          />
          <div>
            <strong>Let Claude search X (experimental)</strong>
            <p>
              Lets Claude search posts, pull a user's tweets, and fetch posts using your
              logged-in X session — so you can ask “search X for…” in the general chat.{' '}
              <em>
                Unofficial &amp; off by default: this drives X's internal API on your
                behalf, which is against X's automation rules and can hit rate limits or
                flag your account. Use at your own risk.
              </em>{' '}
              Each operation must be “primed” once by doing it on X yourself (search once,
              visit a profile once).
            </p>
          </div>
        </label>

        {settings.xTools && (
          <div className="status">
            <div className="status-head">Tool status</div>
            {[
              { label: 'Tweets & replies', on: primed.tweets, hint: 'open any tweet once' },
              { label: 'Search X', on: primed.search, hint: 'search on X once' },
              { label: 'User posts', on: primed.profiles, hint: 'visit a profile once' },
            ].map((row) => (
              <div className="status-row" key={row.label}>
                <span>{row.label}</span>
                <span className={row.on ? 'on' : 'off'}>
                  {row.on ? '● armed' : `○ ${row.hint}`}
                </span>
              </div>
            ))}
          </div>
        )}

        <label className="check">
          <input
            type="checkbox"
            checked={settings.feedAccess}
            onChange={(e) => update({ feedAccess: e.target.checked })}
          />
          <div>
            <strong>Catch me up on my feed (experimental)</strong>
            <p>
              Enables the “Catch me up” button in the chat — a one-click digest of your
              home feed, a person, or a topic, read live from your logged-in X session.{' '}
              <em>
                Unofficial &amp; off by default: this reads X's internal timeline API on
                your behalf, which is against X's automation rules and can hit rate limits
                or flag your account. Read-only, but use at your own risk.
              </em>{' '}
              Open your X home feed once to prime it.
            </p>
          </div>
        </label>
      </section>
    </main>
  );
}
