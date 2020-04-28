/// <reference path="./types/external.d.ts" />

import EventTarget from 'event-target-shim-es5';

import {
  Adapter,
  AdapterConfig,
  AdapterConfigValue,
  AdapterOptions,
  AdapterEnhancer,
  ReadyState,
  SealedAdapter
} from './types/AdapterTypes';

import createAsyncIterableQueue, { AsyncIterableQueue } from './utils/createAsyncIterableQueue';
import createEvent from './utils/createEvent';
import sealAdapter from './sealAdapter';
import Observable, { Subscription } from 'core-js/features/observable';

const DEFAULT_ENHANCER: AdapterEnhancer<any, any, any> = next => options => next(options);

export default function createAdapter<TActivity, TAdapterConfig extends AdapterConfig>(
  options: AdapterOptions = {},
  enhancer: AdapterEnhancer<TActivity, TActivity, TAdapterConfig> = DEFAULT_ENHANCER
): SealedAdapter<TActivity, TAdapterConfig> {
  let mutableAdapterConfig: TAdapterConfig = {} as TAdapterConfig;
  let sealed: boolean;
  let activeSubscription: Subscription;

  const adapter = enhancer(
    (): Adapter<TActivity, TAdapterConfig> => {
      const eventTarget = new EventTarget();
      let ingressQueues: AsyncIterableQueue<TActivity>[] = [];
      let readyStatePropertyValue = ReadyState.CONNECTING;

      return {
        addEventListener: eventTarget.addEventListener.bind(eventTarget),
        dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
        removeEventListener: eventTarget.removeEventListener.bind(eventTarget),

        activities: ({ signal } = {}): AsyncIterable<TActivity> => {
          const queue = createAsyncIterableQueue<TActivity>({ signal });

          ingressQueues.push(queue);

          signal &&
            signal.addEventListener('abort', () => {
              const index = ingressQueues.indexOf(queue);

              ~index || ingressQueues.splice(index, 1);
            });

          return queue.iterable;
        },

        close: () => {
          ingressQueues.forEach(ingressQueue => ingressQueue.end());
          ingressQueues.splice(0, Infinity);
        },

        // Egress middleware API
        egress: (): Promise<void> => {
          return Promise.reject(new Error('There are no enhancers registered for egress().'));
        },

        getConfig: (name: keyof TAdapterConfig) => {
          return mutableAdapterConfig[name];
        },

        getReadyState: () => readyStatePropertyValue,

        // Ingress middleware API
        ingress: activity => {
          ingressQueues.forEach(ingressQueue => ingressQueue.push(activity));
        },

        setConfig: (name: keyof TAdapterConfig, value: AdapterConfigValue) => {
          if (sealed && !(name in mutableAdapterConfig)) {
            throw new Error(`Cannot set config "${name}" because it was not set before being sealed.`);
          }

          // TODO: Fix this typing
          // mutableAdapterConfig[name] = value;
          (mutableAdapterConfig as any)[name] = value;
        },

        setReadyState: (readyState: ReadyState) => {
          if (readyState === readyStatePropertyValue) {
            return;
          }

          if (readyStatePropertyValue === ReadyState.CLOSED) {
            throw new Error('Cannot change "readyState" after it is CLOSED.');
          } else if (
            readyState !== ReadyState.CLOSED &&
            readyState !== ReadyState.CONNECTING &&
            readyState !== ReadyState.OPEN
          ) {
            throw new Error('"readyState" must be either CLOSED, CONNECTING or OPEN.');
          }

          readyStatePropertyValue = readyState;

          if (readyState === ReadyState.CLOSED) {
            activeSubscription && activeSubscription.unsubscribe();
            activeSubscription = null;
          }

          eventTarget.dispatchEvent(createEvent(readyState === ReadyState.OPEN ? 'open' : 'error'));
        },

        subscribe: (observable: Observable<TActivity> | false) => {
          activeSubscription && activeSubscription.unsubscribe();
          activeSubscription = null;

          if (!observable) {
            return;
          }

          let subscription: Subscription;

          observable.subscribe({
            start(thisSubscription: Subscription) {
              activeSubscription = thisSubscription;
              subscription = thisSubscription;
            },

            complete() {
              if (activeSubscription === subscription) {
                activeSubscription = null;
              }
            },

            error(error: Error) {
              if (activeSubscription === subscription) {
                activeSubscription = null;
              }

              // TODO: Propagate the error to fail the adapter.
              // ingressQueues.forEach(ingressQueue => ingressQueue.push(error));
            },

            next(value: TActivity) {
              adapter.ingress(value);
            }
          });
        }
      };
    }
  )(options);

  if (Object.getPrototypeOf(adapter) !== Object.prototype) {
    throw new Error('Object returned from enhancer must not be a class object.');
  }

  const sealedAdapter = sealAdapter(adapter, mutableAdapterConfig);

  sealed = true;

  return sealedAdapter;
}
