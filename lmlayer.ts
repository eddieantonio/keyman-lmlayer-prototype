import { type } from "os";

/**
 * Prototype LMLayer.
 *
 * The real LMLayer will be far better engineered!
 */

// https://www.typescriptlang.org/docs/handbook/triple-slash-directives.html#-reference-lib-

type Weight = number;

// TODO: In a DedicatedWorkerGlobalScope.
interface LMLayerWorkerGlobalScope extends DedicatedWorkerGlobalScope {
  registerModel(factory: ModelFactory): void;
}

interface RequestedConfiguration {
  // TODO
}

interface Configuration {
  /**
   * TODO: ...
   */
  leftContextCodeUnits: number;
}

 /**
  * TODO: ...
  */
interface Model {
  readonly configuration: Configuration;
  predict(...args: any): InternalSuggestion[];
}

/**
 * TODO: ...
 */
interface InternalSuggestion {
  transform: Transform;
  displayAs?: string;
  weight: Weight;
}

type PostMessage = typeof DedicatedWorkerGlobalScope.prototype.postMessage;
type ModelFactory = (c: RequestedConfiguration) => Model;

/**
 * Handles the protocol for communicating with the keyboard.
 *
 * The following callback should be injected:
 *   #postMessage() -- analogous to DedicatedWorkerGlobalScope#postMessage()
 */
class _LMLayer {
  /**
   * The function that handles messages from the keyboard.
   */
  protected handleMessage: (this: _LMLayer, e: MessageEvent) => void;
  /**
   * When defined by registerModel(), you can call this function to instantiate
   * a new model.
   */
  protected createModel?: ModelFactory;
  /**
   * A injectable postMessage() analogue.
   */
  protected postMessage: PostMessage;

  constructor(postMessage: PostMessage = (self as DedicatedWorkerGlobalScope).postMessage) {
    this.postMessage = postMessage;
    this.handleMessage = this.onMessageWhenUninitialized.bind(self);
  }

  install(worker: LMLayerWorkerGlobalScope): this {
    log("Installing...")
    worker.onmessage = this.onMessage.bind(this);
    worker.registerModel = this.registerModel.bind(this);
    return this;
  }

  /**
   * Handles messages from the keyboard.
   *
   * Does some error checking, then delegates to onMessage().
   */
  onMessage(event: MessageEvent) {
    const {message} = event.data;
    if (!message) {
      throw new Error(`Message did not have a 'message' attribute: ${event.data}`);
    }
    log('onMessage....')

    /* Delegate to the current onMessage() handler. */
    return this.handleMessage(event);
  }

  /**
   * Model definition files must call registerModel() once in order to register
   * a function that returns an initialized Model instance to the LMLayer. The
   * LMLayer may then use the registered Model instance to perform predictions.
   */
  registerModel(modelFactory: ModelFactory) {
    this.createModel = modelFactory;
  };

  /**
   * Handles message when uninitialized.
   *
   * Responds only to the `initialize` message.
   */
  protected onMessageWhenUninitialized(event: MessageEvent) {
    const {message} = event.data as Message;

    if (message !== 'initialize') {
      throw new Error('invalid message');
    }
    const {configuration} = event.data;

    // Import the model.
    let model = this.loadModel(event.data.model, configuration);
    this.transitionToReadyState(model);

    // Ready! Send desired configuration.
    this.cast('ready', { configuration: model.configuration });
  }

  /**
   * Loads the model from a separate file.
   */
  protected loadModel(path: string, configuration: RequestedConfiguration) {
    log('Loading model from', path)
    importScripts(path);
    /**
     * The model MUST call registerModel() which ultimately defines
     * createModel() to a function.
     */
    if (this.createModel === undefined) {
      throw new Error('Did not register a model!');
    }

    return this.createModel(configuration);
  }

  /**
   * Call this to transition to the 'ready' state.
   *
   * Sets the onMessage handler to the ready handler, with a model.
   */
  protected transitionToReadyState(model: Model) {
    /**
     * Responds to `predict` messages with a `suggestions` message.
     */
    this.handleMessage = (event: MessageEvent) => {
      const {message, token, transform, context} = event.data;

      if (message !== 'predict') {
        throw new Error('invalid message');
      }

      // XXX: induce the other end to reject the promise, because of a
      // token/message mismatch. This is for testing purposes.
      if (token === null) {
        // @ts-ignore
        this.cast('invalid', {token});
        return;
      }

      let rawSuggestions = model.predict(context, transform);

      // Sort in-place according to weight, ascending.
      rawSuggestions.sort((a, b) => a.weight - b.weight);

      // Convert the internal suggestion format to the one required by the keyboard.
      let suggestions: Suggestion[] = rawSuggestions.map((internal) => {
        let displayAs = internal.displayAs;

        // Try to make up a display string.
        if (displayAs === null || displayAs === undefined) {
          displayAs = internal.transform.insert;
        }

        return {
          transform: internal.transform,
          displayAs
        };
      });

      this.cast('suggestions', { token, suggestions });
    };
  }

  /**
   * Send a well-formatted message to the keyboard.
   */
  protected cast(message: MessageKind, parameters: {}) {
    // Delegate to the (potentially dependency-injected) postMessage.
    this.postMessage({message, ...parameters });
  }
}

log('Instantiating...')
/* Set up the default instance of the LMLayer. */
if (typeof self !== 'undefined') {
  /**
   * HACK: on Node.JS + tiny-worker, ensure code imported with importScripts()
   * has access to the same things defined on self in this file.
   */
  let _lmLayer = (new _LMLayer).install(self as LMLayerWorkerGlobalScope);
  if (typeof global !== 'undefined') {
    let globalPrototype = Object.getPrototypeOf(global);
    Object.setPrototypeOf(self, globalPrototype);
    Object.setPrototypeOf(global, self);
  }
} else {
  log('Refusing to register on self.')
  // @ts-ignore
  this._LMLayer = _LMLayer;
}



function log(...messages: any[]) {
  let error = new Error;
  let indent = error.stack
    ? ' '.repeat((error.stack.match(/\n/g) || []).length - 2)
    : '??? ';
  console.log(indent, ...messages);
}

/*global importScripts*/
