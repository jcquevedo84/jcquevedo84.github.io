const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const CHECK_FAILED = "The security check is temporarily unavailable. Please retry.";

type Turnstile = {
  render(container: HTMLElement, options: {
    sitekey: string;
    action: string;
    appearance: "interaction-only";
    size: "flexible";
    theme: "dark";
    retry: "never";
    "response-field": false;
    "refresh-expired": "manual";
    "refresh-timeout": "manual";
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
    "timeout-callback": () => void;
  }): string;
  remove(widgetId: string): void;
};

type TurnstileWindow = Window & { turnstile?: Turnstile };
let loadingScript: Promise<Turnstile> | undefined;

function loadTurnstile() {
  const browser = window as TurnstileWindow;
  if (browser.turnstile) return Promise.resolve(browser.turnstile);
  loadingScript ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;

    function fail() {
      window.clearTimeout(timer);
      script.remove();
      reject(new Error(CHECK_FAILED));
    }

    const timer = window.setTimeout(fail, 12_000);
    script.onload = () => {
      const turnstile = browser.turnstile;
      if (!turnstile) return fail();
      window.clearTimeout(timer);
      resolve(turnstile);
    };
    script.onerror = fail;
    document.head.append(script);
  }).catch((error) => {
    loadingScript = undefined;
    throw error;
  });
  return loadingScript;
}

export async function getDigitalTwinChallenge(container: HTMLElement, siteKey: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let widgetId: string | undefined;
  let removeWidget: Turnstile["remove"] | undefined;
  let timer: number | undefined;
  let pending = true;
  let onAbort: () => void = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error(CHECK_FAILED));
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      timer = window.setTimeout(fail, 90_000);

      void loadTurnstile().then((turnstile) => {
        signal.throwIfAborted();
        if (!pending) return;
        removeWidget = (id) => turnstile.remove(id);
        widgetId = turnstile.render(container, {
          sitekey: siteKey,
          action: "digital_twin_chat",
          appearance: "interaction-only",
          size: "flexible",
          theme: "dark",
          retry: "never",
          "response-field": false,
          "refresh-expired": "manual",
          "refresh-timeout": "manual",
          callback: (token) => token ? resolve(token) : fail(),
          "error-callback": fail,
          "expired-callback": fail,
          "timeout-callback": fail,
        });
      }).catch(fail);
    });
  } finally {
    pending = false;
    window.clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    if (widgetId) removeWidget?.(widgetId);
  }
}
