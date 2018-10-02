const Worker = require('tiny-worker');

/**
 * Encapuslates the underlying Web Worker through asynchronous calls.
 */
exports.LMLayer = class LMLayer {
  constructor() {
    // LMLayer is a shell that exists in two states:
    // worker is "not ready" or the worker is ready and we can send
    // predictions.
    let worker = new Worker('lmlayer.js');
    this._state = new _UninitializedLMLayer(worker, (configuration) => {
      this._state = new _InitializedLMLayer(worker, configuration);
    });
  }

  /**
   * [async] Waits for the model's initialization.
   */
  initialize() {
    return this._state.initialize();
  }

  /**
   * [async] Sends a context, transform, and token to the LMLayer.
   */
  predictWithContext({transform, context, customToken}) {
    return this._state.predict({transform, context, customToken});
  }
};


/**
 * LMLayer state before we've received the 'ready' message.
 */
class _UninitializedLMLayer {
  constructor(worker, onReady) {
    this._worker = worker;
    this._promise = new Promise((resolve, _reject) => {
      this._resolveInitialized = resolve;
      worker.onmessage = (event) => {
        let {message, configuration} = event.data;
        if (message !== 'ready') {
          throw new Error(`Expected 'ready' message; instead got: ${message}`);
        }

        onReady(configuration);
        resolve(configuration);
      };
    });
  }

  initialize() {
    // This means we're still waiting for the ready signal from
    // the model.
    return this._promise;
  }

  predict(_args) {
    return Promise.reject(new Error('LMLayer is uninitialized'));
  }
}


/**
 * LMLater state after we've recieved the 'ready' message.
 */
class _InitializedLMLayer {
  constructor(worker, configuration) {
    this._worker = worker;
    this._worker.onmessage = this._onmessage.bind(this);
    this.configuration = configuration;

    // Keep track of individual requests to make a nice async/await API.
    this._promises = new PromiseStore;

    // Keep track of tokens.
    this._currentToken = Number.MIN_SAFE_INTEGER;
  }

  /**
   * [async] Waits for the model's initialization.
   */
  initialize() {
    return Promise.resolve(this._configuration);
  }

  /**
   * [async] Sends a context, transform, and token to the LMLayer.
   */
  predict({transform, context, customToken}) {
    let token = customToken === undefined ? this._nextToken() : customToken;

    return new Promise((resolve, reject) => {
      this._promises.track(token, resolve, reject);
      this._cast('predict', {
        token, transform, context
      });
    });
  }

  /**
   * Send a message (a "cast") over to the Web Worker.
   */
  _cast(message, payload) {
    this._worker.postMessage({message, ...payload});
  }

  /**
   * Handles the wrapped worker's onmessage events.
   */
  _onmessage(event) {
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
  _nextToken() {
    let token = this._currentToken++;
    if (!Number.isSafeInteger(token)) {
      throw new RangeError('Ran out of usable tokens');
    }
    return token;
  }
}



/**
 * Associate tokens with promises.
 *
 * You can .track() them, and then .keep() them. You may also .break() them.
 */
class PromiseStore {
  constructor() {
    this._promises = new Map();
  }

  /**
   * Associate a token with its respective resolve and reject callbacks.
   */
  track(token, resolve, reject) {
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
  keep(token) {
    let callbacks = this._promises.get(token);
    if (!callbacks) {
      throw new Error(`No promise associated with token: ${token}`);
    }
    let accept = callbacks.resolve;

    // This acts like the resolve function, BUT, it removes the promise from
    // the store -- because it's resolved!
    return (resolvedValue) => {
      this._promises.delete(token);
      return accept(resolvedValue);
    };
  }

  /**
   * Instantly reject and forget a promise associated with the token.
   */
  break(token, error) {
    let callbacks = this._promises.get(token);
    if (!callbacks) {
      throw new Error(`No promise associated with token: ${token}`);
    }
    this._promises.delete(token);
    callbacks.reject(error);
  }
}
