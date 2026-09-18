# Twin

Twin is an iOS-first conversation-intelligence app. It records conversations, uploads audio for asynchronous processing, creates transcripts and AI debriefs, supports speaker-aware views and voice profiles, and provides chat over recording context.

The shipping mobile application is [`apps/mobile`](apps/mobile). It is an Expo/React Native app with a native Swift background recorder. The API and worker are separate deployable services.

## Architecture

```text
 iOS app (Expo / React Native)
 Firebase authentication · RevenueCat purchases · native background recording
                       │ HTTPS + Firebase ID token
                       ▼
              Fastify API (apps/api)
       auth · account/data API · uploads · webhooks
             │                 │                 │
             ▼                 ▼                 ▼
       PostgreSQL          Redis/BullMQ       S3 storage
                                  │                ▲
                                  ▼                │
                         Worker (apps/api) ────────┘
               transcription · diarization · debriefs
                         │                 │
                         ▼                 ▼
             OpenAI / Deepgram / Anthropic   Python diarization service
```

| Component | Implementation                                      | Purpose                                                                                                               |
| --------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Mobile    | Expo SDK 54, React Native 0.81, Swift module        | Auth, consent, recording, upload, playback, transcripts, debriefs, chat, voice-profile UI, subscriptions              |
| API       | Fastify 5, Prisma                                   | Firebase verification, recording/session APIs, upload/storage operations, deletion, rate limiting, RevenueCat webhook |
| Worker    | BullMQ + Redis                                      | Transcription, speaker diarization, debrief/session-debrief jobs, retries and usage accounting                        |
| Data      | PostgreSQL + S3-compatible storage                  | App metadata and chat in PostgreSQL; audio objects in S3 storage                                                      |
| AI        | OpenAI, Deepgram, Anthropic; optional local Whisper | Speech-to-text, debriefs, chat, and fallback processing                                                               |
| Billing   | RevenueCat + StoreKit                               | iOS subscriptions, entitlement status, purchase restore, lifecycle webhooks                                           |

## Processing flow

1. Firebase authenticates the user; the app records and stores consent state.
2. The native recorder produces audio chunks, including while backgrounded.
3. The app creates a recording/session and uploads chunks to the API.
4. The API writes metadata, stores audio, and places work on Redis queues.
5. The worker transcribes audio, optionally diarizes speakers and applies the saved voice profile, then persists transcript segments.
6. A debrief worker generates structured sections and markdown. A session debrief waits until the app marks the session complete.
7. The app polls for completion and renders recordings, transcript, debrief, and context-aware chat.

### Subscription flow

The app identifies the RevenueCat customer with the Firebase UID and reads the `Twin Pro` entitlement after a purchase or restore. RevenueCat sends lifecycle events to `POST /api/webhooks/revenuecat`; the API uses them to enforce server-side limits. A cancellation or billing issue retains Pro access until actual expiration; expiration/refund removes it.

## Repository layout

```text
apps/
  mobile/                 Shipping Expo app; native iOS workspace is ios/Twin.xcworkspace
  api/                    Fastify API, Prisma schema, workers, Docker image
  web/                    Optional Next.js web dashboard
packages/
  shared/                 Shared models, schemas, and typed API client
  ui/                     Shared UI primitives
services/diarization/     Python FastAPI speaker-diarization service
docker-compose.yml        Local Redis, MinIO, diarization, API/worker/web stack
railway.json              API deployment configuration
```

## Prerequisites

- Node.js 20+ and pnpm 9.15+
- Docker Desktop
- PostgreSQL 15+ for a production-faithful local database
- macOS, Xcode 16+, and CocoaPods for iOS work
- Firebase, S3-compatible storage, and AI-provider credentials for real processing

## Reproduce locally

Run commands from the repo root.

### 1. Install and build shared code

```bash
pnpm install --frozen-lockfile
pnpm --filter=@twin/shared build
```

### 2. Start infrastructure

```bash
docker compose up -d redis minio minio-init diarization
docker run --name twin-postgres \
  -e POSTGRES_USER=twin \
  -e POSTGRES_PASSWORD=twin \
  -e POSTGRES_DB=twin \
  -p 5432:5432 -d postgres:16-alpine
```

```bash
curl http://localhost:8001/health
curl http://localhost:9000/minio/health/live
```

### 3. Configure the API

```bash
cp apps/api/.env.example apps/api/.env
```

Use these local values in `apps/api/.env`:

```dotenv
NODE_ENV=development
API_PORT=3001
API_HOST=0.0.0.0
CORS_ORIGIN=http://localhost:3000
DATABASE_URL=postgresql://twin:twin@localhost:5432/twin
REDIS_URL=redis://localhost:6379
S3_BUCKET=twin
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_ENDPOINT=http://localhost:9000
TRANSCRIPTION_PROVIDER=mock
DEBRIEF_PROVIDER=mock
DIARIZATION_SERVICE_URL=http://localhost:8001
MAX_UPLOAD_SIZE_MB=500
```

Use mock providers for an infrastructure-only run. For real processing, configure the selected provider, for example:

```dotenv
TRANSCRIPTION_PROVIDER=openai
OPENAI_API_KEY=...
DEBRIEF_PROVIDER=claude
ANTHROPIC_API_KEY=...
# Or use TRANSCRIPTION_PROVIDER=deepgram and DEEPGRAM_API_KEY=...
```

Apply the database schema and run the API and worker in separate terminals:

```bash
pnpm --filter=@twin/api db:push
pnpm dev:api
pnpm dev:worker
```

API health: `http://localhost:3001/api/health`.

### 4. Configure and run the mobile app

```bash
cp apps/mobile/.env.example apps/mobile/.env
```

Set valid Firebase web-app configuration and the local API URL:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://localhost:3001
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
EXPO_PUBLIC_FIREBASE_PROJECT_ID=your-project
EXPO_PUBLIC_FIREBASE_APP_ID=...
EXPO_PUBLIC_REVENUECAT_API_KEY=...
```

```bash
cd apps/mobile/ios && pod install && cd ../../..
pnpm --filter=@twin/mobile ios:build
```

For a physical iPhone, replace `localhost` with the computer's LAN IP. The shipping native workspace is `apps/mobile/ios/Twin.xcworkspace`.

## Production deployment

Deploy API and worker as separate processes sharing the same PostgreSQL database, Redis instance, S3 bucket, and environment configuration. The API Dockerfile and Railway configuration are included, but any container platform works.

Required production configuration includes:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://...
REDIS_URL=rediss://...
S3_BUCKET=...
S3_REGION=...
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://... # omit for AWS S3
CORS_ORIGIN=https://your-web-domain.example
FIREBASE_PROJECT_ID=...
FIREBASE_SERVICE_ACCOUNT_JSON=...
REVENUECAT_WEBHOOK_SECRET=...
TRANSCRIPTION_PROVIDER=openai|deepgram|whisper-local
DEBRIEF_PROVIDER=openai|claude
```

Provide the matching AI credentials and a reachable `DIARIZATION_SERVICE_URL` when voice-profile enrollment is enabled. For production, run migrations instead of `db:push`:

```bash
pnpm --filter=@twin/api db:migrate:prod
```

### iOS release build

`apps/mobile/eas.json` contains the App Store production profile.

```bash
cd apps/mobile
pnpm build:production
```

Verify that the production Firebase config, API URL, RevenueCat public SDK key, legal URLs, and bundle identifier `com.abdulrahman.twinai` are the intended production values.

## RevenueCat configuration

The code requires:

- entitlement identifier: `Twin Pro`;
- a current offering with monthly and annual packages;
- App Store Connect products in one subscription group;
- webhook URL: `https://<api-host>/api/webhooks/revenuecat`;
- webhook Authorization header equal to `REVENUECAT_WEBHOOK_SECRET`.

The API refuses to start in production without the webhook secret.

## Validate

```bash
pnpm typecheck
pnpm test
pnpm --filter=@twin/api build
pnpm --filter=@twin/api exec vitest run src/routes/__tests__/webhooks.test.ts
```

## Troubleshooting

| Symptom                        | Check                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Recording stays `processing`   | The worker must run separately and connect to the same Redis, database, and storage as the API. |
| Upload fails                   | Check S3/MinIO endpoint, bucket, credentials, and `MAX_UPLOAD_SIZE_MB`.                         |
| Voice-profile enrollment fails | Check `DIARIZATION_SERVICE_URL` and `curl http://localhost:8001/health`.                        |
| Mobile uses production locally | Restart Metro after setting `EXPO_PUBLIC_API_BASE_URL`; Expo values resolve at bundle time.     |
| Purchases do not unlock limits | Confirm `Twin Pro` exactly matches RevenueCat and the authorized webhook is delivered.          |
| Pods are out of sync           | Run `cd apps/mobile/ios && pod install`.                                                        |

## Privacy

Twin processes account email/UID, recordings, transcripts, debriefs, chat content, and optional voice-profile embeddings. The app includes a privacy manifest, consent/revocation, recording deletion, and account deletion. Keep App Store Connect disclosures, the public policy, and deployed providers aligned with the app's behavior.
