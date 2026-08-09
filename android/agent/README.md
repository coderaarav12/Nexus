# Nexus Agent (Android relay/gateway node)

Always-on relay node for Project Nexus. Runs as a foreground service, reports node
metrics to the server every 3 seconds, and relays chunk transfers between LAN devices
and the central server.

> **JDK requirement (IMPORTANT):** AGP 8.7 requires **JDK 17 or JDK 21**.
> **JDK 26 is NOT supported** — the build will fail on startup with an
> "Unsupported class file major version" style error. Make sure
> `java -version` reports 17 or 21 before running Gradle.

## Build

```sh
cd android/agent

# generate the Gradle wrapper (requires Gradle 8.9+ on PATH; JDK 17/21)
gradle wrapper --gradle-version 8.9

# build a debug APK
gradle assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`.

## Install via adb

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## First-run setup

1. Open the **Nexus Agent** app.
2. Enter the server URL (default `http://192.168.1.100:8080`) and a node name
   (the phone model is pre-filled).
3. Tap **Register** — the app calls `POST /api/v1/agent/register` and stores the
   returned node token (in `EncryptedSharedPreferences`) and node id.
4. Tap **Start service** — a persistent notification appears and the relay starts
   listening on `0.0.0.0:9123`.
5. Allow the **POST_NOTIFICATIONS** permission prompt if shown (Android 13+).

The service also restarts automatically on device boot and after app updates
(`BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`), plus a self-correcting
`AlarmManager.setExactAndAllowWhileIdle` kick every 3 s.

## Battery optimization

The phones act as gateways **24/7 and should be kept plugged in**. After the first
run, open **Open battery settings** in the app and disable battery optimization for
Nexus Agent. The app also holds a `PARTIAL_WAKE_LOCK` while relaying a transfer.

## Server endpoints the app calls (base `http://<server>:8080`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/v1/agent/register` | onboarding, returns `{node_id, token}` |
| POST | `/api/v1/agent/heartbeat` | metric reporting, returns `{now, score, jobs}` |
| POST | `/api/v1/agent/jobs/:jobId/claim` | claim a queued transfer |
| POST | `/api/v1/agent/jobs/:jobId/chunks/:index` | relay upload chunk (octet-stream) |
| GET | `/api/v1/agent/jobs/:jobId/chunks/:index` | relay download chunk (octet-stream) |
| POST | `/api/v1/agent/jobs/:jobId/complete` | finish a transfer |
| POST | `/api/v1/agent/jobs/:jobId/fail` | report a failed transfer |

All agent calls send `Authorization: Bearer <nodeToken>`; chunk/complete/fail calls
also send the `x-job-token` header. LAN devices talk to the phone's relay at
`http://<phone-ip>:9123/relay/v1/jobs/:jobId/chunks/:index`.

## Notes

- Download jobs pre-fetch all chunks into `cacheDir/relay/<jobId>/`; chunk progress is
  stored in SharedPreferences so a restart resumes (chunks already on disk are reused).
- A stalled transfer is failed after 10 minutes so the queue keeps moving.
