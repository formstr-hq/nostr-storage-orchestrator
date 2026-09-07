declare global {
  interface Window {
    __formstrSigner?: boolean;
    nostr?: {
      getPublicKey(): Promise<string>;
      signEvent(event: unknown): Promise<unknown>;
    };
  }
}

export {};
