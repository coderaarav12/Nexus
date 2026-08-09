# Nexus Backup (Android)

Silent photo/video backup app for Project Nexus. Runs on family members' personal
phones, finds new media in MediaStore, and uploads it into the user's server vault.

## Build

Requirements: JDK 17, Android Studio (or a command line with Gradle 8.9+ installed).

```
cd android/backup
gradle wrapper --gradle-version 8.9
gradlew :app:assembleDebug
```

Install on a phone (or use Android Studio Run):

```
adb install app/build/outputs/apk/debug/app-debug.apk
```

## Onboarding

1. Open the app. Enter the server URL (`http://<server-ip>:8080`, the scheme is
   added automatically if omitted), your Nexus username, and password.
2. If the account has 2FA enabled, enter the 6-digit code when prompted.
3. The app registers a device named "Phone Backup" (`platform: android`) and stores
   the device-bound access/refresh tokens in `EncryptedSharedPreferences`.
4. Grant media access. Android 13+ asks for `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO`
   and `POST_NOTIFICATIONS`; Android 8-12 asks for `READ_EXTERNAL_STORAGE`.

## How backup runs

- WorkManager schedules a periodic run every 12 h (the OS minimum) plus a
  one-time run when the app is opened and when the app receives a
  `NEW_PICTURE` / `MEDIA_SCANNER_SCAN_FILE` broadcast.
- Wi-Fi-only and charge-only are enforced both by WorkManager constraints and
  re-checked inside the worker. If blocked, the run is rescheduled.
- Each run queries MediaStore for images and videos with
  `DATE_ADDED >= lastUploadedDate` and `IS_PENDING = 0`, oldest first.
- Files smaller than 1 KB are skipped. Files are deduped client-side by
  MediaStore ID (`sha256 + size + dateAdded` persisted in SharedPreferences),
  so they are never re-read or re-uploaded, even if dates change.
- Uploads run one file at a time to stay gentle on the phone.

## Upload flow (per file)

1. Compute SHA-256 by streaming the file in 64 KB chunks.
2. `POST /api/v1/sync/upload` `{filename, size, sha256, mtime, parentId}`.
   If `deduped` is true, record it locally and skip.
3. Otherwise stream the file: for each 1 MiB (`job.chunkSize`) slice, send
   `POST /api/v1/sync/jobs/<jobId>/chunks/<index>` with
   `Content-Type: application/octet-stream` and header `x-job-token`.
   If the server replies `gap:true` (or `skipped`), jump to `resumeIndex`.
4. `POST /api/v1/sync/jobs/<jobId>/complete` with `x-job-token`. On success the
   `sha256` is recorded in the local dedupe state.
5. Any error stops the run immediately (no hammering), the last error is stored
   and shown in the UI, and the work is rescheduled.

Any authed call that returns 401 triggers one token refresh
(`POST /api/v1/auth/refresh`) and one retry. If refresh is rejected, the session
is cleared and the app returns to the login screen.

## Vault layout

Uploads are organized by the media's capture time:

```
My Vault/
  Backups/
    2026/
      06/
        IMG_1234.jpg
```

Folders (`Backups` -> `YYYY` -> `MM`) are looked up via
`GET /api/v1/storage/vault/<parentId>` and created with
`POST /api/v1/storage/vault/folder` only when missing; ids are cached per run.
If folder resolution fails, the file is uploaded to the vault root as a fallback.

## Battery / network guidance

- Enable "Only on Wi-Fi" by default to avoid mobile data use; uploads wait until
  the phone is on Wi-Fi (WorkManager will hold the job).
- Enable "Only while charging" if you want to keep battery drain at zero; the job
  runs when the phone is plugged in.
- Backups are one file at a time with no wake locks beyond WorkManager's.
- `READ_EXTERNAL_STORAGE` was deprecated in Android 13; the app requests the
  scoped `READ_MEDIA_*` permissions there. `NEW_PICTURE` broadcasts are no longer
  delivered to manifest receivers on Android 13+, so fresh media is picked up by
  the next periodic run or on app open.
