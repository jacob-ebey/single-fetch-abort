import * as React from "react";
import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";

export const meta: MetaFunction = () => {
  return [
    { title: "New Remix App" },
    { name: "description", content: "Welcome to Remix!" },
  ];
};

export async function action({ request }: ActionFunctionArgs) {
  const formData = new URLSearchParams(await request.text());
  let words = Number.parseInt(formData.get("words") ?? "10");
  let delay = Number.parseInt(formData.get("delay") ?? "400");
  const throwError = formData.get("throwError") === "on";

  words = Number.isSafeInteger(words) && words > 0 ? words : 10;
  delay = Number.isSafeInteger(delay) && delay > 0 ? delay : 400;

  return createPromiseStream(async function* () {
    for (let i = 0; i < words; i++) {
      await new Promise((resolve) => setTimeout(resolve, delay));

      if (throwError && i === 4) throw new Error("Error at 5th word");

      yield String(i + 1);
    }
  });
}

export default function Index() {
  const fetcher = useFetcher<typeof action>();
  const stream = usePromiseStream(fetcher.data);

  return (
    <main>
      <fetcher.Form method="post">
        <label>
          Number of words:{" "}
          <input type="number" name="words" defaultValue="10" />
        </label>
        <br />
        <label>
          Delay (ms): <input type="number" name="delay" defaultValue="400" />
        </label>
        <br />
        <label>
          Throw Error? <input type="checkbox" name="throwError" />
        </label>
        <br />
        {fetcher.state !== "idle" || stream.state === "streaming" ? (
          <button
            type="button"
            onClick={(event) => {
              fetcher.abort(fetcher);
              event.preventDefault();
            }}
          >
            Abort
          </button>
        ) : (
          <button type="submit">Start</button>
        )}
      </fetcher.Form>
      <p>Fetcher State: {fetcher.state}</p>
      <p>Stream State: {stream.state}</p>
      <ul>
        {stream.chunks.map((chunk) => (
          <li key={chunk}>{chunk}</li>
        ))}
      </ul>
      {stream.state === "error" && (
        <p className="text-red-500">{String(stream.error)}</p>
      )}
    </main>
  );
}

// ========================================================
// Streaming implementation
// ========================================================

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

type PromiseStream<T> =
  | {
      type: "value";
      value: T;
      next?: Promise<PromiseStream<T> | null | undefined>;
    }
  | {
      type: "error";
      error: unknown;
    };

type PromiseStreamState<T> =
  | {
      state: "idle";
      chunks: T[];
    }
  | {
      state: "streaming";
      chunks: T[];
    }
  | {
      state: "done";
      chunks: T[];
    }
  | {
      state: "error";
      chunks: T[];
      error: unknown;
    };

function createPromiseStream<T>(
  factory: () => AsyncGenerator<T, void, unknown>
) {
  let deferred: Deferred<PromiseStream<T> | undefined> = new Deferred();
  const initialPromise = deferred.promise;

  (async () => {
    try {
      const generator = factory();
      for await (const value of generator) {
        const next = new Deferred<PromiseStream<T> | undefined>();
        deferred.resolve({ type: "value", value, next: next.promise });
        deferred = next;
      }
      deferred.resolve(undefined);
    } catch (error) {
      deferred.resolve({ type: "error", error });
    }
  })();

  return initialPromise;
}

function streamStateFromPromiseStream<T>(
  promiseStream?: PromiseStream<T> | null | undefined
): PromiseStreamState<T> {
  if (!promiseStream) return { state: "idle", chunks: [] };
  if (promiseStream.type === "error")
    return { state: "error", chunks: [], error: promiseStream.error };
  if (promiseStream.next) {
    return { state: "streaming", chunks: [] };
  }
  return { state: "done", chunks: [] };
}

function usePromiseStream<T>(
  promiseStream?: PromiseStream<T> | null | undefined
): PromiseStreamState<T> {
  const [streamState, setStreamState] = React.useState(
    streamStateFromPromiseStream(promiseStream)
  );

  React.useEffect(() => {
    let aborted = false;

    setStreamState(streamStateFromPromiseStream(promiseStream));

    (async () => {
      let currentPromiseStream = promiseStream;
      while (currentPromiseStream && !aborted) {
        switch (currentPromiseStream.type) {
          case "error": {
            const error = currentPromiseStream.error;
            setStreamState(({ chunks }) => ({ state: "error", chunks, error }));
            return;
          }
          case "value": {
            const chunk = currentPromiseStream.value;
            const state = currentPromiseStream.next ? "streaming" : "done";
            setStreamState(({ chunks }) => ({
              state,
              chunks: [...chunks, chunk],
            }));
            currentPromiseStream = await Promise.resolve(
              currentPromiseStream.next
            ).catch(
              (error): PromiseStream<T> => ({
                type: "error",
                error,
              })
            );
            if (!currentPromiseStream) {
              setStreamState((state) => ({
                ...state,
                state: "done",
              }));
              return;
            }
            break;
          }
          default:
            console.error("Invalid promise stream type", currentPromiseStream);
            return;
        }
      }
    })();

    return () => {
      aborted = true;
    };
  }, [promiseStream]);

  return streamState;
}
