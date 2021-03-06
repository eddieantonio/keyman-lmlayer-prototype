/**
 * Sample implementation of the "keyboard", for testing the LMLayer.
 */

interface InitializeParameters {
  model: string;
  configuration?: Configuration;
}

interface PredictParameters {
  transform: Transform;
  context: Context;
  customToken?: Token;
}

/**
 * Encapsulates the underlying Web Worker through asynchronous calls.
 */
export class LMLayer {
  private _worker: Worker;
  private _promises: PromiseStore<SuggestionsMessage>;
  private _currentToken: number;
  private _configuration: Configuration | null;
  private _resolveInitialized: Function | null;

  constructor() {
    // Worker state
    this._worker = new Worker('lmlayer.js');
    this._worker.onmessage = this._onmessage.bind(this);

    // Keep track of individual requests to make a nice async/await API.
    this._promises = new PromiseStore;

    // Keep track of tokens.
    this._currentToken = Number.MIN_SAFE_INTEGER;

    // State related to model initialization and configuration.
    this._configuration = null;
    this._resolveInitialized = null;
  }

  /**
   * [async] Waits for the model's initialization.
   */
  initialize({model, configuration }: InitializeParameters) {
    if (this._configuration) {
      return Promise.resolve(this._configuration);
    }

    // _onMessage() will resolve this Promise.
    return new Promise((resolve, _reject) => {
      this._cast('initialize', {
        model,
        configuration: {
          maxLeftContextCodeUnits: 32,
          supportsRightContexts: false,
          ...configuration
        }
      });
      this._resolveInitialized = resolve;
    }) as Promise<Configuration>;
  }

  /**
   * [async] Sends a context, transform, and token to the LMLayer.
   */
  predict({transform, context, customToken}: PredictParameters) {
    if (!this._configuration) {
      return Promise.reject(new Error('Model is not initialized.'));
    }

    let token = customToken === undefined ? this._nextToken() : customToken;

    return new Promise((resolve, reject) => {
      this._promises.track(token, resolve, reject);
      this._cast('predict', {
        token, transform, context
      });
    }) as Promise<SuggestionsMessage>;
  }


  /**
   * Send a message (a "cast") over to the Web Worker.
   */
  _cast(message: MessageKind, payload: object) {
    this._worker.postMessage({message, ...payload});
  }

  /**
   * Handles the wrapped worker's onmessage events.
   */
  _onmessage(event: MessageEvent) {
    const {message, token} = event.data;

    if (message === 'ready') {
      let configuration = event.data.configuration || {};
      this._configuration = configuration;
      this._resolveInitialized && this._resolveInitialized(configuration);
      return;
    }

    let accept = this._promises.keep(token);

    if (message === 'suggestions') {
      accept(event.data);
    } else {
      this._promises.break(token,
        new Error(`Unknown message: ${message}`)
      );
    }
  }

  /**
   * Returns the next token. Note: mutates state.
   */
  _nextToken(): Token {
    let token = this._currentToken++;
    if (!Number.isSafeInteger(token)) {
      throw new RangeError('Ran out of usable tokens');
    }
    return token;
  }
}

type Resolve<T> = (value?: T | PromiseLike<T>) => void;
type Reject = (reason?: any) => void;
interface PromiseCallbacks<T> {
  resolve: Resolve<T>;
  reject: Reject;
}

/**
 * Associate tokens with promises.
 *
 * You can .track() them, and then .keep() them. You may also .break() them.
 */
class PromiseStore<T> {
  private _promises: Map<Token, PromiseCallbacks<T>>;

  constructor() {
    this._promises = new Map();
  }

  /**
   * Associate a token with its respective resolve and reject callbacks.
   */
  track(token: Token, resolve: Resolve<T>, reject: Reject) {
    if (this._promises.has(token)) {
      reject(`Existing request with token ${token}`);
    }
    this._promises.set(token, {reject, resolve});
  }

  /**
   * Fetch a promise's resolution function.
   *
   * Calling the resolution function will stop tracking the promise.
   */
  keep(token: Token) {
    let callbacks = this._promises.get(token);
    if (!callbacks) {
      throw new Error(`No promise associated with token: ${token}`);
    }
    let accept = callbacks.resolve;

    // This acts like the resolve function, BUT, it removes the promise from
    // the store -- because it's resolved!
    return (resolvedValue: T) => {
      this._promises.delete(token);
      return accept(resolvedValue);
    };
  }

  /**
   * Instantly reject and forget a promise associated with the token.
   */
  break(token: Token, error: Error) {
    let callbacks = this._promises.get(token);
    if (!callbacks) {
      throw new Error(`No promise associated with token: ${token}`);
    }
    this._promises.delete(token);
    callbacks.reject(error);
  }
}

if (typeof module !== 'undefined') {
  // In Node JS, monkey-patch Worker to the global object.
  // @ts-ignore
  global.Worker = require('tiny-worker');
}

declare module NodeJS  {
  interface Global {
      Worker: typeof Worker;
  }
}
