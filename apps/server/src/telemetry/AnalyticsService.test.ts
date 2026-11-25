import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { ManagedPolicyDocument } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { getTelemetryIdentity } from "./Identify.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
        readonly serverOs?: string;
        readonly serverArch?: string;
        readonly serverAppVersion?: string;
        readonly serverMode?: string;
        readonly t3CodeVersion?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
      readonly serverOs?: string;
      readonly serverArch?: string;
      readonly serverAppVersion?: string;
      readonly serverMode?: string;
      readonly t3CodeVersion?: string;
    };
  }>;
}

const SentBatch = Schema.fromJsonString(
  Schema.Struct({
    batch: Schema.Array(
      Schema.Struct({
        uuid: Schema.String,
        event: Schema.String,
        distinct_id: Schema.String,
        properties: Schema.Struct({
          telemetryChannel: Schema.String,
          installId: Schema.optionalKey(Schema.String),
          ownerSource: Schema.optionalKey(Schema.String),
          observedBy: Schema.optionalKey(Schema.String),
        }),
      }),
    ),
  }),
);
const decodeSentBatch = Schema.decodeEffect(SentBatch);
type SentEvent = (typeof SentBatch.Type)["batch"][number];
type Respond = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const respondWithStatus =
  (status: number): Respond =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })));

/**
 * Answers 503 for `minutes` after the first send, then 204. `answers` holds each
 * answer with its time in ms after the first send (the test clock runs on across tests).
 */
const failingFor = (minutes: number) => {
  const answers: Array<{ readonly at: number; readonly status: number }> = [];
  let firstSend: number | undefined;
  const respond: Respond = (request) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      firstSend ??= now;
      const at = now - firstSend;
      const status = at < minutes * 60_000 ? 503 : 204;
      answers.push({ at, status });
      return respondWithStatus(status)(request);
    });
  return { respond, answers };
};

const FLUSH_INTERVAL = "10 seconds";

const recordTwentyEvents = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  for (let index = 0; index < 20; index += 1) {
    yield* analytics.record("test.retry", { index });
  }
});

const analyticsLayerWith = (
  client: HttpClient.HttpClient,
  policy?: ManagedPolicyDocument,
  startupConfig: Record<string, unknown> = { T3CODE_TELEMETRY_ENABLED: true },
  hostOverrides: Layer.Layer<never, never, FileSystem.FileSystem> = Layer.empty,
) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-retry-" }),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...startupConfig,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(HttpClient.HttpClient, client),
        ManagedPolicy.layerTest(policy),
      ),
    ),
    Layer.provide(hostOverrides),
  );

/**
 * Runs `record` (20 events by default), then lets `minutes` of background
 * flushes run against a client that answers every send with `respond`.
 * Returns the sent batches.
 */
const sendFor = (
  minutes: number,
  respond: Respond,
  record: Effect.Effect<
    void,
    never,
    AnalyticsService.AnalyticsService | Effect.Services<typeof getTelemetryIdentity>
  > = recordTwentyEvents,
  policy?: ManagedPolicyDocument,
  startupConfig?: Record<string, unknown>,
  hostOverrides?: Layer.Layer<never, never, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const batches: Array<ReadonlyArray<SentEvent>> = [];
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Uint8Array") {
          const body = yield* decodeSentBatch(new TextDecoder().decode(request.body.body)).pipe(
            Effect.orDie,
          );
          batches.push(body.batch);
        }
        return yield* respond(request);
      }),
    );
    const runtimeLayer = analyticsLayerWith(client, policy, startupConfig, hostOverrides);

    yield* Effect.gen(function* () {
      yield* record;
      for (let second = 0; second < minutes * 60; second += 1) {
        yield* TestClock.adjust("1 second");
      }
    }).pipe(Effect.provide(runtimeLayer));
    return batches;
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AnalyticsService test", (it) => {
  it.effect("waits for desktop shell consent and honors a late telemetry opt-out", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.record("test.before-discovery");
          yield* analytics.flush;
          env.T3CODE_TELEMETRY_ENABLED = "false";
          delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
          yield* analytics.record("test.opted-out");
          yield* analytics.flush;
          env.T3CODE_TELEMETRY_ENABLED = "true";
          yield* analytics.record("test.allowed");
          yield* analytics.flush;
        }),
      ).pipe(Effect.provideService(HostProcess.Environment, env));
      assert.deepEqual(
        batches.flat().map((event) => event.event),
        ["test.allowed"],
      );
    }),
  );

  it.effect.each([
    { login: undefined, sent: [] },
    { login: "true", sent: ["test.after-discovery"] },
  ])(
    "desktop shell consent is opt-in when the startup environment sets nothing (login shell: $login)",
    ({ login, sent }) =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
        const batches = yield* sendFor(
          0,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            yield* analytics.record("test.before-discovery");
            yield* analytics.flush;
            if (login !== undefined) env.T3CODE_TELEMETRY_ENABLED = login;
            delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
            yield* analytics.record("test.after-discovery");
            yield* analytics.flush;
          }),
          undefined,
          {},
        ).pipe(Effect.provideService(HostProcess.Environment, env));
        assert.deepEqual(
          batches.flat().map((event) => event.event),
          sent,
        );
      }),
  );

  it.effect.each([
    { name: "off", startupConfig: {}, resolvesIdentity: false },
    { name: "on", startupConfig: { T3CODE_TELEMETRY_ENABLED: true }, resolvesIdentity: true },
  ])(
    "reads provider login files and server owners only while telemetry is $name",
    ({ startupConfig, resolvesIdentity }) =>
      Effect.gen(function* () {
        const home = "/tmp/t3-telemetry-test-home";
        const reads: Array<string> = [];
        const hostOverrides = Layer.mergeAll(
          Layer.succeed(HostProcess.HomeDirectory, home),
          Layer.effect(
            FileSystem.FileSystem,
            Effect.map(FileSystem.FileSystem, (fileSystem) => ({
              ...fileSystem,
              readFileString: (path: string, encoding?: string) => {
                reads.push(path);
                return fileSystem.readFileString(path, encoding);
              },
            })),
          ),
        );
        let anonymousIdCreated: boolean | undefined;
        let ownersResolved = false;
        const batches = yield* sendFor(
          0,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            const { anonymousIdPath } = yield* ServerConfig.ServerConfig;
            const fileSystem = yield* FileSystem.FileSystem;
            yield* analytics.record("test.identity");
            yield* analytics.recordOwners(
              Effect.sync(() => {
                ownersResolved = true;
                return [{ source: "connect" as const, ownerId: "a".repeat(64) }];
              }),
              "server",
            );
            yield* analytics.flush;
            // The anonymous id is written by the same identity lookup that reads the login files.
            anonymousIdCreated = yield* fileSystem.exists(anonymousIdPath).pipe(Effect.orDie);
          }),
          undefined,
          startupConfig,
          hostOverrides,
        );
        assert.deepEqual(
          reads.filter((path) => path.startsWith(home)),
          resolvesIdentity ? [`${home}/.codex/auth.json`, `${home}/.claude.json`] : [],
        );
        assert.equal(anonymousIdCreated, resolvesIdentity);
        assert.equal(ownersResolved, resolvesIdentity);
        assert.deepEqual(
          batches.flat().map((event) => event.event),
          resolvesIdentity ? ["test.identity", "install.owner_observed"] : [],
        );
      }),
  );

  it.effect(
    "a server owner read held back by desktop shell consent runs once consent arrives",
    () =>
      Effect.gen(function* () {
        const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
        let ownerReads = 0;
        const batches = yield* sendFor(
          1,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            yield* analytics.recordOwners(
              Effect.sync(() => {
                ownerReads += 1;
                return [{ source: "connect" as const, ownerId: "b".repeat(64) }];
              }),
              "server",
            );
            assert.equal(ownerReads, 0);
            env.T3CODE_TELEMETRY_ENABLED = "true";
            delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
            const { anonymousIdPath } = yield* ServerConfig.ServerConfig;
            const fileSystem = yield* FileSystem.FileSystem;
            const identityResolved = fileSystem.exists(anonymousIdPath).pipe(Effect.orDie);
            yield* analytics.record("test.consent");
            // Recording never waits on the login-file reads; the first send does them.
            assert.isFalse(yield* identityResolved);
            // Resolved here so the flush fiber, which would not wait for file I/O under the test clock, finds it.
            yield* analytics.flush;
            assert.isTrue(yield* identityResolved);
            assert.equal(ownerReads, 0);
          }),
          undefined,
          {},
        ).pipe(Effect.provideService(HostProcess.Environment, env));
        assert.equal(ownerReads, 1);
        assert.deepEqual(
          batches.flat().map((event) => event.event),
          ["test.consent", "install.owner_observed"],
        );
      }),
  );

  it.effect("sends nothing when telemetry is turned off while the identity is being resolved", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const secureRandom = yield* SecureRandom.SecureRandom;
      const resolving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const batches = yield* sendFor(
        0,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          env.T3CODE_TELEMETRY_ENABLED = "true";
          delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
          yield* analytics.record("test.event");
          const flushing = yield* analytics.flush.pipe(Effect.forkChild);
          yield* Deferred.await(resolving);
          env.T3CODE_TELEMETRY_ENABLED = "false";
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(flushing);
        }),
        undefined,
        {},
      ).pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(SecureRandom.SecureRandom, {
          ...secureRandom,
          uuidV4: () =>
            Deferred.succeed(resolving, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(secureRandom.uuidV4()),
            ),
        }),
      );
      assert.deepEqual(batches, []);
    }),
  );

  it.effect("a failing server owner read does not stop periodic delivery", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const sentAt: Array<number> = [];
      const ownerRead = yield* Deferred.make<void>();
      const batches = yield* sendFor(
        1,
        (request) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            sentAt.push(now);
            return respondWithStatus(204)(request);
          }),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.recordOwners(
            Deferred.succeed(ownerRead, undefined).pipe(Effect.andThen(Effect.die("unreadable"))),
            "server",
          );
          env.T3CODE_TELEMETRY_ENABLED = "true";
          delete env.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING;
          // Resolves the identity here: under the test clock the flush fiber would not wait for its file I/O.
          yield* analytics.record("test.consent");
          yield* analytics.flush;
          // The next tick runs the held-back owner read, which fails; only then is the event recorded.
          yield* TestClock.adjust(FLUSH_INTERVAL);
          yield* Deferred.await(ownerRead);
          yield* analytics.record("test.after");
        }),
        undefined,
        {},
      ).pipe(Effect.provideService(HostProcess.Environment, env));
      assert.deepEqual(
        batches.flat().map((event) => event.event),
        ["test.consent", "test.after"],
      );
      // The background loop sends it, not the flush when the scope closes at the end of the minute.
      assert.isBelow((sentAt.at(-1) ?? Infinity) - (sentAt[0] ?? 0), 60_000);
    }),
  );

  it.effect(
    "a defect while resolving the identity turns telemetry off instead of failing callers",
    () =>
      Effect.gen(function* () {
        const secureRandom = yield* SecureRandom.SecureRandom;
        let uuidV4Calls = 0;
        const batches = yield* sendFor(
          0,
          respondWithStatus(204),
          Effect.gen(function* () {
            const analytics = yield* AnalyticsService.AnalyticsService;
            yield* analytics.record("test.first");
            yield* analytics.record("test.second");
            yield* analytics.flush;
          }),
        ).pipe(
          Effect.provideService(SecureRandom.SecureRandom, {
            ...secureRandom,
            uuidV4: () =>
              Effect.sync(() => (uuidV4Calls += 1)).pipe(Effect.andThen(Effect.die("no entropy"))),
          }),
        );
        assert.deepEqual(batches, []);
        // The failed lookup is remembered, not retried for each event.
        assert.equal(uuidV4Calls, 1);
      }),
  );

  it.effect("client owner reports cannot use up the server's owner cap", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(
        10,
        respondWithStatus(204),
        Effect.gen(function* () {
          const analytics = yield* AnalyticsService.AnalyticsService;
          yield* analytics.recordOwners(
            Array.from({ length: 1_001 }, (_, index) => ({
              source: "device" as const,
              ownerId: index.toString(16).padStart(64, "0"),
            })),
            "client",
          );
          // The event buffer also holds 1,000, so send the client events first.
          yield* analytics.flush;
          yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        }),
      );
      const owners = batches.flat().map((event) => event.properties.observedBy);

      assert.equal(owners.filter((observedBy) => observedBy === "client").length, 1_000);
      assert.equal(owners.filter((observedBy) => observedBy === "server").length, 1);
    }),
  );

  it.effect("keeps a failed batch through a 20-minute outage and sends it once after", () =>
    Effect.gen(function* () {
      const ingest = failingFor(20);
      const batches = yield* sendFor(40, ingest.respond);
      const statuses = ingest.answers.map(({ status }) => status);
      assert.equal(statuses.at(-1), 204);
      assert.equal(statuses.filter((status) => status === 204).length, 1);
      const sentUuids = new Set(batches.map((batch) => batch.map(({ uuid }) => uuid).join()));
      assert.equal(sentUuids.size, 1);
      assert.equal(batches[0]?.length, 20);
    }),
  );

  it.effect("drops a batch that keeps failing for 30 minutes", () =>
    Effect.gen(function* () {
      const ingest = failingFor(Infinity);
      yield* sendFor(60, ingest.respond);
      const lastSend = ingest.answers.at(-1)?.at ?? 0;
      assert.isAtLeast(lastSend, 30 * 60_000);
      assert.isBelow(lastSend, 36 * 60_000);
    }),
  );

  it.effect(
    "sends nothing when a managed policy turns telemetry off, despite the environment",
    () =>
      Effect.gen(function* () {
        const policy = { schemaVersion: 1, organization: "Example Corp" } as const;
        const allowed = yield* sendFor(1, respondWithStatus(204), recordTwentyEvents, {
          ...policy,
          limits: { telemetry: true },
        });
        assert.equal(allowed.length, 1);
        const denied = yield* sendFor(1, respondWithStatus(204), recordTwentyEvents, {
          ...policy,
          limits: { telemetry: false },
        });
        assert.deepEqual(denied, []);
      }),
  );

  it.effect("drops a batch the endpoint rejects without sending it again", () =>
    Effect.gen(function* () {
      const batches = yield* sendFor(10, respondWithStatus(400));
      assert.equal(batches.length, 1);
    }),
  );

  it.effect("shutdown stops waiting for a telemetry endpoint that never answers", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        analyticsLayerWith(HttpClient.make(() => Effect.never)),
        scope,
      );
      yield* recordTwentyEvents.pipe(Effect.provide(context));

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(shutdown);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-base-",
      });

      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
          T3CODE_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.orElseSucceed(() => null),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            ManagedPolicy.layerTest(),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const { distinctId } = yield* getTelemetryIdentity;
        assert.equal(distinctId !== null, true);
        const analytics = yield* AnalyticsService.AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every(
          (request) => request.path.endsWith("/batch/") || request.path.endsWith("/batch"),
        ),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every(
            (event) =>
              event.properties?.serverOs === "Linux" &&
              event.properties.serverArch === "arm64" &&
              event.properties.serverAppVersion === event.properties.t3CodeVersion &&
              event.properties.serverMode === "web",
          ),
        ),
        true,
      );
    }),
  );

  it.effect.each([
    { name: "disabled", env: { T3CODE_TELEMETRY_ENABLED: false } },
    { name: "not opted in", env: {} },
  ])("does not send batch requests when telemetry is $name", ({ env }) =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...env,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            ManagedPolicy.layerTest(),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );
});
