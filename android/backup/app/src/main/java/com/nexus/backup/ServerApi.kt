package com.nexus.backup

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

class SessionLost : IOException("Session expired")

enum class RefreshResult { OK, REJECTED, NETWORK }

sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Error(val message: String, val code: Int = 0) : ApiResult<Nothing>()
}

data class LoginResult(val grantToken: String, val mfaRequired: Boolean)

data class VaultItem(val id: Long, val name: String, val kind: String)

data class UploadJob(
    val jobId: String,
    val jobToken: String,
    val itemId: Long,
    val chunkSize: Long,
    val totalBytes: Long,
    val deduped: Boolean
)

data class ChunkResult(val ok: Boolean, val skipped: Boolean, val gap: Boolean, val resumeIndex: Long)

class ServerApi(private val context: android.content.Context, private val auth: AuthStore) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    var sessionLost: (() -> Unit)? = null

    private val base: String get() = auth.serverUrl().trimEnd('/')
    private val jsonType = "application/json; charset=utf-8".toMediaType()
    private val octetType = "application/octet-stream".toMediaType()

    private fun jsonPost(url: String, payload: JSONObject): Response =
        client.newCall(Request.Builder().url(url).post(payload.toString().toRequestBody(jsonType)).build()).execute()

    private fun authedRequest(build: (String) -> Request): Response {
        var token = auth.accessToken() ?: throw SessionLost()
        var resp = client.newCall(build(token)).execute()
        if (resp.code == 401) {
            resp.close()
            when (refreshOnce()) {
                RefreshResult.OK -> {
                    token = auth.accessToken() ?: throw SessionLost()
                    resp = client.newCall(build(token)).execute()
                }
                RefreshResult.REJECTED -> throw SessionLost()
                RefreshResult.NETWORK -> throw IOException("token refresh failed")
            }
        }
        return resp
    }

    private fun Response.json(): JSONObject = JSONObject(body?.string() ?: "{}")

    private fun errorOf(resp: Response): String =
        try {
            val json = resp.json()
            json.optString("error").takeIf { it.isNotBlank() } ?: "HTTP ${resp.code}"
        } catch (_: Exception) {
            "HTTP ${resp.code}"
        }

    fun login(username: String, password: String): ApiResult<LoginResult> {
        return try {
            val payload = JSONObject().put("username", username).put("password", password)
            jsonPost("$base/api/v1/auth/login", payload).use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                val json = resp.json()
                ApiResult.Success(
                    LoginResult(
                        grantToken = json.getString("grantToken"),
                        mfaRequired = json.optBoolean("mfaRequired", false)
                    )
                )
            }
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun mfa(grantToken: String, code: String): ApiResult<String> {
        return try {
            val payload = JSONObject().put("grantToken", grantToken).put("code", code)
            jsonPost("$base/api/v1/auth/mfa", payload).use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                ApiResult.Success(resp.json().getString("grantToken"))
            }
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun registerDevice(grantToken: String, name: String, platform: String, osVersion: String): ApiResult<Unit> {
        return try {
            val payload = JSONObject()
                .put("grantToken", grantToken)
                .put("name", name)
                .put("platform", platform)
                .put("osVersion", osVersion)
            jsonPost("$base/api/v1/auth/devices/register", payload).use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                val json = resp.json()
                auth.saveDevice(
                    json.getString("deviceId"),
                    json.getString("accessToken"),
                    json.getString("refreshToken")
                )
                ApiResult.Success(Unit)
            }
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun refreshOnce(): RefreshResult {
        val refreshToken = auth.refreshToken() ?: return RefreshResult.REJECTED
        return try {
            val payload = JSONObject().put("refreshToken", refreshToken)
            jsonPost("$base/api/v1/auth/refresh", payload).use { resp ->
                if (!resp.isSuccessful) {
                    auth.clear()
                    sessionLost?.invoke()
                    return RefreshResult.REJECTED
                }
                val json = resp.json()
                auth.saveTokens(json.getString("accessToken"), json.getString("refreshToken"))
                RefreshResult.OK
            }
        } catch (e: Exception) {
            LogBuffer.add(context, "refresh failed: ${e.message}")
            RefreshResult.NETWORK
        }
    }

    fun listChildren(parentId: Long?): ApiResult<List<VaultItem>> {
        return try {
            val url = if (parentId == null) "$base/api/v1/storage/vault" else "$base/api/v1/storage/vault/$parentId"
            authedRequest { token ->
                Request.Builder().url(url).header("Authorization", "Bearer $token").get().build()
            }.use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                val arr: JSONArray = resp.json().optJSONArray("items") ?: JSONArray()
                val items = (0 until arr.length()).map { i ->
                    val o = arr.getJSONObject(i)
                    VaultItem(o.getLong("id"), o.getString("name"), o.getString("kind"))
                }
                ApiResult.Success(items)
            }
        } catch (e: SessionLost) {
            ApiResult.Error("session expired")
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun createFolder(name: String, parentId: Long?): ApiResult<Long> {
        return try {
            val payload = JSONObject().put("name", name)
            if (parentId != null) payload.put("parentId", parentId)
            authedRequest { token ->
                Request.Builder().url("$base/api/v1/storage/vault/folder")
                    .header("Authorization", "Bearer $token")
                    .post(payload.toString().toRequestBody(jsonType))
                    .build()
            }.use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                val id = resp.json().getJSONObject("folder").getLong("id")
                ApiResult.Success(id)
            }
        } catch (e: SessionLost) {
            ApiResult.Error("session expired")
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun createUploadJob(
        filename: String,
        size: Long,
        sha256: String,
        mtime: Long,
        parentId: Long?
    ): ApiResult<UploadJob> {
        return try {
            val payload = JSONObject()
                .put("filename", filename)
                .put("size", size)
                .put("sha256", sha256)
                .put("mtime", mtime)
            if (parentId != null) payload.put("parentId", parentId)
            authedRequest { token ->
                Request.Builder().url("$base/api/v1/sync/upload")
                    .header("Authorization", "Bearer $token")
                    .post(payload.toString().toRequestBody(jsonType))
                    .build()
            }.use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                val json = resp.json()
                ApiResult.Success(
                    UploadJob(
                        jobId = json.optString("jobId"),
                        jobToken = json.optString("jobToken"),
                        itemId = json.optLong("itemId", 0L),
                        chunkSize = json.optLong("chunkSize", 1024L * 1024L),
                        totalBytes = json.optLong("totalBytes", size),
                        deduped = json.optBoolean("deduped", false)
                    )
                )
            }
        } catch (e: SessionLost) {
            ApiResult.Error("session expired")
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun uploadChunk(jobId: String, jobToken: String, index: Long, bytes: ByteArray): ApiResult<ChunkResult> {
        return try {
            val url = "$base/api/v1/sync/jobs/$jobId/chunks/$index"
            val req = Request.Builder().url(url)
                .header("x-job-token", jobToken)
                .header("Authorization", "Bearer ${auth.accessToken() ?: ""}")
                .post(bytes.toRequestBody(octetType))
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                val json = resp.json()
                ApiResult.Success(
                    ChunkResult(
                        ok = json.optBoolean("ok", false),
                        skipped = json.optBoolean("skipped", false),
                        gap = json.optBoolean("gap", false),
                        resumeIndex = if (json.has("resumeIndex")) json.getLong("resumeIndex") else -1L
                    )
                )
            }
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun completeJob(jobId: String, jobToken: String): ApiResult<Unit> {
        return try {
            val payload = JSONObject().put("jobToken", jobToken)
            val req = Request.Builder().url("$base/api/v1/sync/jobs/$jobId/complete")
                .header("x-job-token", jobToken)
                .header("Authorization", "Bearer ${auth.accessToken() ?: ""}")
                .post(payload.toString().toRequestBody(jsonType))
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                ApiResult.Success(Unit)
            }
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }

    fun failJob(jobId: String, jobToken: String, error: String): ApiResult<Unit> {
        return try {
            val payload = JSONObject().put("error", error)
            val req = Request.Builder().url("$base/api/v1/sync/jobs/$jobId/fail")
                .header("x-job-token", jobToken)
                .header("Authorization", "Bearer ${auth.accessToken() ?: ""}")
                .post(payload.toString().toRequestBody(jsonType))
                .build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return ApiResult.Error(errorOf(resp))
                ApiResult.Success(Unit)
            }
        } catch (e: Exception) {
            ApiResult.Error(e.message ?: "network error")
        }
    }
}
