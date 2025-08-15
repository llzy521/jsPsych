import autoBind from "auto-bind";

export type KeyboardListener = (e: KeyboardEvent) => void;

export type ValidResponses = string[] | "ALL_KEYS" | "NO_KEYS";

export interface GetKeyboardResponseOptions {
  callback_function: any;
  valid_responses?: ValidResponses;
  rt_method?: "performance" | "audio";
  persist?: boolean;
  audio_context?: AudioContext;
  audio_context_start_time?: number;
  allow_held_key?: boolean;
  minimum_valid_rt?: number;
  /**
   * Whether this listener should be treated as high priority.
   * High priority listeners are processed FIFO and exclusively when present.
   */
  priority?: "normal" | "high";
}

export class KeyboardListenerAPI {
  constructor(
    private getRootElement: () => Element | undefined,
    private areResponsesCaseSensitive: boolean = false,
    private minimumValidRt = 0
  ) {
    autoBind(this);
    this.registerRootListeners();
  }

  private listeners = new Set<KeyboardListener>();
  private heldKeys = new Set<string>();

  private areRootListenersRegistered = false;

  // High-priority handling
  private highPriorityQueue: Array<(e: KeyboardEvent) => boolean> = [];
  private highPriorityTokenToHandler = new Map<KeyboardListener, (e: KeyboardEvent) => boolean>();
  private highPriorityHandlerToToken = new Map<(e: KeyboardEvent) => boolean, KeyboardListener>();

  /**
   * If not previously done and `this.getRootElement()` returns an element, adds the root key
   * listeners to that element.
   */
  private registerRootListeners() {
    if (!this.areRootListenersRegistered) {
      const rootElement = this.getRootElement();
      if (rootElement) {
        rootElement.addEventListener("keydown", this.rootKeydownListener);
        rootElement.addEventListener("keyup", this.rootKeyupListener);
        this.areRootListenersRegistered = true;
      }
    }
  }

  private rootKeydownListener(e: KeyboardEvent) {
    // If there are high-priority listeners queued, handle only the head of the queue
    if (this.highPriorityQueue.length > 0) {
      const handler = this.highPriorityQueue[0];
      const handled = handler(e);
      if (handled) {
        this.highPriorityQueue.shift();
        const token = this.highPriorityHandlerToToken.get(handler);
        if (token) {
          this.highPriorityTokenToHandler.delete(token);
          this.highPriorityHandlerToToken.delete(handler);
        }
      }
    } else {
      // Iterate over a static copy of the listeners set because listeners might add other listeners
      // that we do not want to be included in the loop
      for (const listener of [...this.listeners]) {
        listener(e);
      }
    }
    this.heldKeys.add(this.toLowerCaseIfInsensitive(e.key));
  }

  private toLowerCaseIfInsensitive(string: string) {
    return this.areResponsesCaseSensitive ? string : string.toLowerCase();
  }

  private rootKeyupListener(e: KeyboardEvent) {
    this.heldKeys.delete(this.toLowerCaseIfInsensitive(e.key));
  }

  private isResponseValid(validResponses: ValidResponses, allowHeldKey: boolean, key: string) {
    // check if key was already held down
    if (!allowHeldKey && this.heldKeys.has(key)) {
      return false;
    }

    if (validResponses === "ALL_KEYS") {
      return true;
    }
    if (validResponses === "NO_KEYS") {
      return false;
    }

    return validResponses.includes(key);
  }

  getKeyboardResponse({
    callback_function,
    valid_responses = "ALL_KEYS",
    rt_method = "performance",
    persist,
    audio_context,
    audio_context_start_time,
    allow_held_key = false,
    minimum_valid_rt = this.minimumValidRt,
    priority = "normal",
  }: GetKeyboardResponseOptions) {
    if (rt_method !== "performance" && rt_method !== "audio") {
      console.log(
        'Invalid RT method specified in getKeyboardResponse. Defaulting to "performance" method.'
      );
      rt_method = "performance";
    }

    const usePerformanceRt = rt_method === "performance";
    const startTime = usePerformanceRt ? performance.now() : audio_context_start_time * 1000;

    this.registerRootListeners();

    if (!this.areResponsesCaseSensitive && typeof valid_responses !== "string") {
      valid_responses = valid_responses.map((r) => r.toLowerCase());
    }

    // High-priority listener path (FIFO, exclusive, single-use)
    if (priority === "high") {
      const handler = (e: KeyboardEvent) => {
        const rt = Math.round(
          (rt_method == "performance" ? performance.now() : audio_context.currentTime * 1000) -
            startTime
        );
        if (rt < minimum_valid_rt) {
          return false;
        }
        const key = this.toLowerCaseIfInsensitive(e.key);
        if (this.isResponseValid(valid_responses, allow_held_key, key)) {
          e.preventDefault();
          callback_function({ key: e.key, rt });
          return true; // consumed and single-use
        }
        return false; // not handled; remain queued
      };

      // Create a cancellation token compatible with cancelKeyboardResponse
      const token: KeyboardListener = () => {};
      this.highPriorityQueue.push(handler);
      this.highPriorityTokenToHandler.set(token, handler);
      this.highPriorityHandlerToToken.set(handler, token);
      return token;
    }

    // Normal listener path (existing behavior)
    const listener: KeyboardListener = (e) => {
      const rt = Math.round(
        (rt_method == "performance" ? performance.now() : audio_context.currentTime * 1000) -
          startTime
      );
      if (rt < minimum_valid_rt) {
        return;
      }

      const key = this.toLowerCaseIfInsensitive(e.key);

      if (this.isResponseValid(valid_responses, allow_held_key, key)) {
        // if this is a valid response, then we don't want the key event to trigger other actions
        // like scrolling via the spacebar.
        e.preventDefault();

        if (!persist) {
          // remove keyboard listener if it exists
          this.cancelKeyboardResponse(listener);
        }

        callback_function({ key: e.key, rt });
      }
    };

    this.listeners.add(listener);
    return listener;
  }

  cancelKeyboardResponse(listener: KeyboardListener) {
    // remove the listener from the set of listeners if it is contained
    if (this.listeners.delete(listener)) {
      return;
    }
    // If it's a high-priority token, remove from the queue and maps
    const handler = this.highPriorityTokenToHandler.get(listener);
    if (handler) {
      const index = this.highPriorityQueue.indexOf(handler);
      if (index !== -1) {
        this.highPriorityQueue.splice(index, 1);
      }
      this.highPriorityTokenToHandler.delete(listener);
      this.highPriorityHandlerToToken.delete(handler);
    }
  }

  cancelAllKeyboardResponses() {
    this.listeners.clear();
    // Clear high-priority queue as well
    this.highPriorityQueue = [];
    this.highPriorityTokenToHandler.clear();
    this.highPriorityHandlerToToken.clear();
  }

  compareKeys(key1: string | null, key2: string | null) {
    if (
      (typeof key1 !== "string" && key1 !== null) ||
      (typeof key2 !== "string" && key2 !== null)
    ) {
      console.error(
        "Error in jsPsych.pluginAPI.compareKeys: arguments must be key strings or null."
      );
      return undefined;
    }

    if (typeof key1 === "string" && typeof key2 === "string") {
      // if both values are strings, then check whether or not letter case should be converted before comparing (case_sensitive_responses in initJsPsych)
      return this.areResponsesCaseSensitive
        ? key1 === key2
        : key1.toLowerCase() === key2.toLowerCase();
    }

    return key1 === null && key2 === null;
  }
}
