# Hoplite Platform starter: Site Studio

Site Studio is an example product built on [Hoplite's Platform API](https://hoplite.sh/docs/platform). A business owner describes a website in chat, a Hoplite agent builds it, the owner watches a live preview, and each change becomes a version they can publish or roll back. Business details (services, prices, opening hours, team) stay live on the website through a small browser "Site Kit", without a new version.

It is a Next.js interface with a custom Node server. The server holds the Hoplite credential, relays previews through its own gateway, stores built releases and serves the published website. Hoplite supplies the agent runtime, source versions, editing workspaces, previews and builds.

The interface is white-label on purpose. Owners see "Site Studio" and their own business name; they never see Hoplite, the model, error codes or build logs. A test (`apps/studio/tests/customer-copy.test.ts`) fails if a platform or technology name reaches the interface. Rename the product by changing the copy and `apps/studio/public/studio-logo.svg`.

This is an example to read and adapt, not a finished product. See [Known limitations](#known-limitations).

## What it demonstrates

Every Platform API call is made from the server, in `apps/studio/lib/hoplite.ts` (the HTTP client) and `apps/studio/lib/service.ts` (the workflow).

| Platform API | How the example uses it | Where |
| --- | --- | --- |
| [Apps](https://hoplite.sh/docs/platform) | One app per website. `POST /apps` sets `externalId` (the studio's site id), `runScript`, `previewPort`, `defaultModel` and `idleTimeoutMinutes`. If the create is retried after its idempotency receipt expired, `app_external_id_conflict` is answered by finding the app with `GET /apps?externalId=…`. | `ensureApp` in `lib/service.ts` |
| Sources | The starter files are imported once with `POST /apps/{id}/sources`. After each run, `GET /sources/{sourceId}/files` reads the immutable result so the studio can check it before building. | `performAdmission`, `verifySource` |
| Threads and runs | The first request creates a thread from the source with a prompt. Follow-ups post to `/threads/{id}/messages`. The studio polls `/runs/{runId}` for `status` and `resultSourceId`, and reads `/messages` for the reply and progress lines. | `performAdmission`, `tick` |
| [Previews and the gateway](https://hoplite.sh/docs/platform/previews) | `POST /preview/start` and `GET /preview?frameOrigin=…` return a preview URL and a five-minute gateway credential. The studio's own gateway (a separate origin) authenticates the owner, adds the credential header, relays HTTP and WebSocket traffic, and replaces platform or provider pages with its own neutral "waking" and "paused" pages. | `previewGrant` in `lib/service.ts`, `lib/preview-gateway.ts`, `server.ts` |
| [Builds](https://hoplite.sh/docs/platform/versions) | `POST /threads/{id}/builds` builds a pinned `sourceId`. The studio polls `/builds/{buildId}`, downloads `/artifact`, verifies its hash, saves `/logs` on failure, and stores the release itself. Hoplite never publishes anything. | `startBuild`, `tick` |
| [Idle and wake lifecycle](https://hoplite.sh/docs/platform/operations) | `POST /workspace/activity` renews the 20-minute idle deadline on real owner activity only (throttled to one call every 30 seconds). `GET /workspace/policy` is read every 20 seconds while idle to show "Preview paused" once the workspace is archived. A wake renews the deadline first, then starts the preview. | `recordWorkspaceActivity`, `workspacePolicy`, the wake functions in `lib/service.ts` |
| Rate limiting | After a `429` the client holds every request until `Retry-After` has passed (capped at 60 seconds, 10 seconds when the header is missing). A read is retried once; a write reports the `429` so its caller replays it under the same idempotency key. Transcript reads are limited to one every 10 seconds per website. | `Hoplite.response` in `lib/hoplite.ts` |
| Idempotency keys | Every write sends `Idempotency-Key`. The key is saved before the request, so a retry after a timeout or a restart replays the same operation instead of starting a second run or build. Keys: `studio-app-{siteId}`, `{siteId}-seed`, the attempt id for a thread or message, `build-{versionId}`. `409 operation_outcome_pending` and `409 build_busy` keep the operation waiting instead of failing it. | `lib/service.ts`, `definitelyFailed` in `lib/hoplite.ts` |

Not used by this example:

- **Drafts and applies** (`/source-head/initialize`, `/threads/{id}/apply`). The studio allows one change at a time and keeps its own "ready" and "published" pointers, so it never merges concurrent drafts. See [Versions and builds](https://hoplite.sh/docs/platform/versions) if your product needs that.
- **[Events](https://hoplite.sh/docs/platform/events)**. The studio polls runs, messages and builds every 2.5 seconds instead of consuming the event stream.
- Stopping a run, reading usage and deleting an app.

## Prerequisites

- A Hoplite workspace with an active plan, and the **Platform API enabled for it by Hoplite**. Until it is enabled, every request answers `403 platform_api_not_enabled`, and the studio tells the owner that website creation isn't switched on yet. To request access, email support@hoplite.sh with your workspace name and workspace ID; the [Platform overview](https://hoplite.sh/docs/platform) has the details.
- A **service account key**. Create it under **Settings → Workspace → API keys → Service accounts**: leave **Projects** under **Access** on **All projects**, because the studio creates its own app; set **Permissions** to **None** (a new account starts with Read on every scope); then set **Projects** and **Threads** to **Write** and leave every other scope on **None**. The studio's calls check `project:create`, `project:read`, `project:update`, `thread:create`, `thread:read` and `thread:update`. Deleting an app, which the studio never does, checks `project:delete`; Projects: Write includes it. The [quickstart](https://hoplite.sh/docs/platform/quickstart) shows the steps.
- Node 24 and pnpm 10.31.0 (`corepack enable` selects it).
- Google Chrome, for the accessibility check, the optional browser checks and the website import. Without Chrome the accessibility check is skipped and logged.

## Run locally

```sh
cp .env.example .env   # then set HOPLITE_SERVICE_KEY
pnpm install
pnpm dev
```

Open **http://127.0.0.1:4320**. The preview gateway listens on 4321 and the published website on 4322. All three bind to loopback only. For a steadier run without development tooling, use `pnpm build && pnpm start`.

`pnpm install` warns about ignored build scripts for `esbuild` and `sharp`. That is pnpm's default and both ship prebuilt binaries; nothing needs approving.

A first visit opens onboarding: check the sample business details, optionally import an existing website for its colours and images, then choose **Create my website**. A prompt is optional. Afterwards the home page is that website: chat, live preview, versions and publishing.

The first website takes about three minutes to appear, most of it the agent's run; the build, the accessibility check and the preview follow within about half a minute. A small chat edit takes between one and two minutes. Publishing is immediate, because the release is already stored. Each of these is a paid agent run; see [Costs](#costs).

Things to try:

1. Ask for a headline or colour change and watch the new version appear.
2. Edit **Business details** and refresh the preview. Site Kit shows the new facts at once, with no new version.
3. Tell the agent a business fact in chat ("we're closed on Mondays"). It proposes a change to the details, and you confirm it with one tap.
4. Choose **Publish website**, open the published website, then restore an earlier version from **Versions**.
5. Leave the preview for 20 minutes. It shows "Your preview is paused"; **Wake preview** or any activity in the studio restores it from saved source.

State is kept under `.data/` (ignored by git). Delete that directory to start again; the Hoplite app it created stays in your workspace. Its id is `appId` in `.data/metadata.json`. Remove it in the [Platform console](https://app.hoplite.sh/platform), or with `DELETE /api/platform/v1/apps/{appId}` and a key that has `project:delete`.

## Configuration

Set these in `.env` for `pnpm dev` and `pnpm start`, or in the container's environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOPLITE_API_URL` | none (required) | The Hoplite API base URL, `https://api.hoplite.sh`. HTTPS is required outside localhost. |
| `HOPLITE_SERVICE_KEY` | none (required) | The service account key. Server-side only. |
| `STUDIO_QA_CHECKS` | `off` | `on` gates every draft on the full browser checks before it can be published. |
| `STUDIO_ACCESS_PASSWORD` | unset | Turns on the shared-password gate for the studio and the preview gateway. |
| `STUDIO_SESSION_SECRET` | unset | Signs the gate's cookies. At least 32 characters; required with a password. |
| `STUDIO_ORIGIN` | `http://127.0.0.1:4320` | Public origin of the studio. |
| `STUDIO_PREVIEW_ORIGIN` | `http://127.0.0.1:4321` | Public origin of the preview gateway. |
| `STUDIO_SITES_ORIGIN` | `http://127.0.0.1:4322` | Public origin of the published website. |
| `STUDIO_LISTEN_HOST` | `127.0.0.1` | Interface the public listeners bind to. |
| `STUDIO_LISTEN_PORT` | unset | One port for all three roles, chosen by `Host` header. When unset, each role has its own port: `STUDIO_PORT`, `STUDIO_PREVIEW_PORT`, `STUDIO_SITES_PORT` (4320, 4321, 4322). |
| `STUDIO_CHECK_PORT` | `4321` | Loopback-only gateway port for the in-process browser checks, opened when the preview origin is not the loopback address. Never expose it. |
| `STUDIO_TRUST_PROXY` | unset | `fly` trusts `Fly-Client-IP` (login rate limiting) and `X-Forwarded-Proto` (HTTP is redirected to HTTPS). Set it only behind Fly's proxy. |
| `STUDIO_DATA_DIR` | `.data` in the repository root | `metadata.json`, local-file releases and imported brand assets. |
| `STUDIO_RELEASE_BUCKET`, `STUDIO_RELEASE_REGION`, `STUDIO_RELEASE_PREFIX`, `STUDIO_RELEASE_ENDPOINT` | unset | Store releases in your own S3-compatible bucket instead of local files. Credentials come from the AWS SDK's standard chain. The provider must support conditional `PutObject` with `If-None-Match: *`. |
| `STUDIO_STAFF_TOOLS` | off in production | `on` shows the raw check report and the artifact download in the publish dialog. |
| `STUDIO_STARTER_IMAGE` | unset | A custom sandbox image id that Hoplite provided and enabled for your workspace on request. See [Custom sandbox image](#custom-sandbox-image). |
| `STUDIO_SITE_ID` | unset | Development only: open a particular saved site from `metadata.json`. |

The server fails at startup with a clear message if two origins share a host, an origin has a path, or a port collides. Hosted, the three origins must be subdomains of one registrable domain, because the studio frames the gateway and the gateway's cookies are `SameSite`.

## How a change flows

1. **Admit.** The owner's request is wrapped in instructions (`instructions` in `lib/service.ts`) and sent as a thread prompt or a follow-up message. The operation id is saved first. A definite refusal fails the change with a plain message; an uncertain outcome (timeout, dropped connection, 5xx) is replayed with the same key by **Try again**.
2. **Generate.** The studio polls the run. The agent's `[studio-status]` lines become the progress line beside the spinner and are stripped from the conversation.
3. **Check the source.** The result files must pass the source gates (`lib/safety.ts`): only pages and the stylesheet may change, Studio-owned files keep their bytes, and secret-like content, server code and remote resources are rejected.
4. **Build.** The pinned source is built on Hoplite with a 300-second limit. The studio stops waiting after 10 minutes and offers **Try again**, which rebuilds the same draft.
5. **Quick accessibility check.** Every build gets a contrast and labelling check on each page at a phone and a desktop size. Findings get one automatic repair and never block publishing.
6. **Optional browser checks** (`STUDIO_QA_CHECKS=on`). Every route is exercised on the live preview and the built artifact at three sizes.
7. **Ready, then publish.** The draft becomes ready once its evidence is stored. Only **Publish website** moves the public pointer; **Restore website** moves it back.

Failures of the agent's own work (a failing build command, a source gate, a browser check) are sent back to the agent for repair. A change gets at most two repairs in total, and infrastructure failures never spend one.

## Custom sandbox image

By default each workspace and build installs the website's dependencies with `npm install`, which needs network access and takes time on a cold start.

Hoplite can provide a **custom sandbox image** with the dependencies preinstalled. Hoplite builds each image and enables it for your workspace on request: email support@hoplite.sh with your workspace name and say you want an image for this example's `starter:prepare` output (see [Sandbox images](https://hoplite.sh/docs/platform)). You cannot publish one yourself, and an id that isn't enabled for your workspace is refused with `sandbox_image_not_allowed`. The example works without one: the default path was run end to end against the hosted API in October 2026. When you have an image id, set `STUDIO_STARTER_IMAGE`. New websites then use "starter version 2" (`apps/studio/starter-v2`): the app's run script becomes `studio-site-v2 dev`, builds run `studio-site-v2 build`, and the app is created with `sandboxImage`.

The image must provide the `studio-site-v2` command. `site-runtime.mjs` is that command: it verifies the Studio-owned files against a manifest, links the preinstalled dependencies, drops inherited credentials from the environment and runs Astro. To produce the files the image needs:

```sh
pnpm --filter site-studio starter:prepare /absolute/empty/directory
```

This writes `package.json`, `package-lock.json`, `protected-files.json` and `site-runtime.mjs`. The image should contain that directory with `npm ci` already run in it, and a `studio-site-v2` command on the `PATH` that links to its `site-runtime.mjs`. Ask for the image again after changing `apps/studio/seed/public/site-kit.js` or `apps/studio/starter-v2`, because the manifest pins their hashes.

The private demo this example came from also included a script that published the image to Hoplite's own sandbox account, a sandbox acceptance test for it, and a launcher for a local copy of Hoplite's control plane. They only work inside Hoplite's infrastructure and were removed.

## Deploy

The example runs as one long-lived container with a persistent volume. It needs three public HTTPS hostnames (studio, preview gateway, published website) that reach the same container port.

```sh
docker build --platform linux/amd64 -t site-studio .
docker run --rm -p 8080:8080 -v studio-data:/data \
  -e HOPLITE_API_URL=https://api.hoplite.sh \
  -e HOPLITE_SERVICE_KEY=... \
  -e STUDIO_ORIGIN=https://studio.example.com \
  -e STUDIO_PREVIEW_ORIGIN=https://preview.studio.example.com \
  -e STUDIO_SITES_ORIGIN=https://sites.studio.example.com \
  -e STUDIO_ACCESS_PASSWORD=... \
  -e STUDIO_SESSION_SECRET="$(openssl rand -base64 48)" \
  site-studio
```

The image contains Node 24, the built studio and Google Chrome (published for linux/amd64 only). It sets `STUDIO_LISTEN_HOST=0.0.0.0`, `STUDIO_LISTEN_PORT=8080` and `STUDIO_DATA_DIR=/data`. The container starts as root only to make the volume writable and runs the server as `node`. `GET /healthz` answers `200 ok` on every hostname once startup has finished.

- Run **one instance**. Metadata is one atomically replaced file and the background loop assumes a single writer.
- Keep it **always on**. Builds, checks and idle tracking run in the server's own loop; a stopped or suspended instance pauses a change halfway.
- Put a TLS-terminating proxy in front that preserves the `Host` header. Requests for any other host get `403 Invalid host`.
- Back up the volume. It holds the only copy of the metadata and, without a release bucket, of the releases.

`fly.example.toml` is a starting point for Fly.io: copy it to `fly.toml`, replace the placeholders, create the app and a volume, set the four secrets with `fly secrets set`, run `fly deploy --ha=false`, and add a certificate for each hostname.

## Security notes

- **The key stays on the server.** `HOPLITE_SERVICE_KEY`, preview URLs and gateway credentials never reach the browser. The client refuses a non-HTTPS API URL outside localhost and never follows redirects.
- **Password gate.** With `STUDIO_ACCESS_PASSWORD`, every studio page and API call needs a session cookie: HMAC-signed, `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, host-only, valid for 12 hours. Failed sign-ins are limited to 10 per client and 100 overall per 15 minutes. It is one shared password, not user accounts. Without it, anyone who can reach the studio can use it, so leave it unset only on loopback.
- **Preview gateway.** Previews are served from a separate origin so generated code can't read the studio's session. The gateway keeps its own host-only cookie, issued through a single-use, one-minute handoff from the studio. It strips cookies and authorization headers before relaying, adds the Hoplite credential server-side, never accepts an upstream URL from the browser, and removes the sandbox's private paths from preview HTML.
- **Published websites are public.** Their `/book` page and `/site-kit/leads` endpoint are test-only: they create no appointment and send no email.
- **Generated source is untrusted.** Source gates run before every build, and preview and published responses carry a same-origin resource policy. These are pattern checks, not a complete security boundary.
- **Website import.** The importer fetches one public page through a DNS-pinned transport that rejects private addresses, credentials and nonstandard ports. Imported observations are passed to the agent as untrusted context.
- Prompts and chat content are never written to the server log.

## Costs

Every website creation, chat edit and automatic repair is an agent run billed to your Hoplite workspace, and every preview and build runs a sandbox. The example creates apps with `claude-opus-5-5` as the default model, which is the most expensive option. There is no environment variable for it: change `defaultModel` in `ensureApp` (`apps/studio/lib/service.ts`) for new websites, or on an existing app with `PATCH /api/platform/v1/apps/{appId}`. A change can trigger up to two automatic repair runs. Anyone who can use the studio can spend those credits, so share the password narrowly and rotate it. Service account keys expire; rotate the key before it does.

## Tests

```sh
pnpm typecheck
pnpm build
pnpm test             # unit tests: no Hoplite backend, no browser
pnpm test:browser     # needs Google Chrome
pnpm test:lifecycle   # needs Chrome and free ports 4320 to 4322
pnpm test:storage     # needs a real S3 bucket; see tests/release-storage.live.ts
```

CI (`.github/workflows/ci.yml`) runs the first three. The unit tests use a fake Hoplite client; none of the tests calls the real API.

## Known limitations

- One business and one website per deployment. There are no user accounts, organisations or membership checks: replace the password gate with your own authentication.
- Metadata is a local JSON file and the server is a single process. A real product would use a database and a job queue.
- Booking and enquiry endpoints are test-only, and there is no custom-domain provisioning, billing interface or notification integration.
- Generated websites are static Astro sites limited to pages and one stylesheet.
- The studio polls rather than using the event stream, and it cannot stop a run in progress: **Stop this change** only stops waiting for it.
- The source gates and the resource policy are not a sandbox egress policy or a full code-security review.
- The Platform API is a release candidate, and this example follows it as of October 2026.
- The sample business ("Harbour Studio", Galway) and the sample website under `apps/studio/seed` are demo seed data. The sample pages use typography and colour only; the repository ships no photographs. New websites start from a blank foundation and never receive the sample pages.

## Licence

MIT, copyright Carbon Copy Markets, Inc.; see `LICENSE`. Third-party fonts and adapted code are listed in `NOTICE.md` with their own licences.
