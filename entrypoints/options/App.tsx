import { useEffect, useState } from 'react';
import { buildAuthorizeUrl, exchangeCode, generatePkce } from '@/utils/oauth';
import { DEFAULT_SETTINGS, MODELS, getSettings, saveSettings } from '@/utils/settings';
import type { Settings } from '@/utils/types';

type OAuthStep = 'idle' | 'waiting-for-code' | 'exchanging';

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [oauthStep, setOauthStep] = useState<OAuthStep>('idle');
  const [pastedCode, setPastedCode] = useState('');
  const [verifier, setVerifier] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [primed, setPrimed] = useState({ tweets: false, search: false, profiles: false });

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

  if (!loaded) return null;

  const connected = Boolean(settings.oauth?.refreshToken);

  return (
    <main className="page">
      <h1>
        <span className="coral">✳</span> Claude for X
      </h1>
      <p className="subtitle">Ask Claude about any post on X — like Grok, but Claude.</p>

      {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

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

      <section>
        <h2>Model</h2>
        <select
          value={settings.model}
          onChange={(e) => update({ model: e.target.value })}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </section>

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
      </section>
    </main>
  );
}
