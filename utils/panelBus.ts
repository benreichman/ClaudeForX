// Tiny bus connecting the injected page buttons (plain DOM code) to the React
// panel living in the shadow root.

export type OpenRequest =
  | { kind: 'tweet'; tweetId: string; article: HTMLElement | null }
  | { kind: 'profile'; handle: string };

type Listener = (req: OpenRequest) => void;

let listener: Listener | null = null;

export const panelBus = {
  open(req: OpenRequest): void {
    listener?.(req);
  },
  /** Returns an unsubscribe function. */
  onOpen(l: Listener): () => void {
    listener = l;
    return () => {
      if (listener === l) listener = null;
    };
  },
};
