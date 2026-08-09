package com.nexus.agent

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class AgentJob(
    val jobId: String,
    val direction: String,
    val totalBytes: Long,
    val bytesDone: Long,
    val chunkSize: Long,
    val itemId: String,
    val sha256: String?,
    val jobToken: String,
    val nodeId: String,
    val nodeName: String?
)

class ServerApi(private val baseUrl: String) {

    class ApiException(val code: Int, message: String) : Exception(message)

    data class Heartbeat(val now: Long, val score: Double, val jobs: List<AgentJob>)

    data class Claim(val job: JSONObject?, val status: String)

    data class Chunk(val bytes: ByteArray, val start: Long, val end: Long, val total: Long)

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val base = baseUrl.trimEnd('/')

    suspend fun register(name: String, model: String, osVersion: String): Pair<String, String> =
        withContext(Dispatchers.IO) {
            val body = JSONObject()
                .put("name", name)
                .put("model", model)
                .put("osVersion", osVersion)
                .toString()
            val resp = executeJson("$base/api/v1/agent/register", token = null, jobToken = null, jsonBody = body)
            resp.getString("node_id") to resp.getString("token")
        }

    suspend fun heartbeat(token: String, payload: JSONObject): Heartbeat =
        withContext(Dispatchers.IO) {
            val resp = executeJson("$base/api/v1/agent/heartbeat", token, null, payload.toString())
            val jobs = parseJobs(resp.optJSONArray("jobs"))
            Heartbeat(resp.optLong("now"), resp.optDouble("score", 0.0), jobs)
        }

    suspend fun claim(token: String, jobId: String): Claim =
        withContext(Dispatchers.IO) {
            val resp = executeJson("$base/api/v1/agent/jobs/$jobId/claim", token, null, "{}")
            Claim(resp.optJSONObject("job"), resp.optString("status"))
        }

    suspend fun postChunk(token: String, jobId: String, index: Int, jobToken: String, bytes: ByteArray): JSONObject =
        withContext(Dispatchers.IO) {
            postChunkBlocking(token, jobId, index, jobToken, bytes)
        }

    suspend fun getChunk(token: String, jobId: String, index: Int, jobToken: String): Chunk =
        withContext(Dispatchers.IO) {
            getChunkBlocking(token, jobId, index, jobToken)
        }

    suspend fun complete(token: String, jobId: String, jobToken: String) =
        withContext(Dispatchers.IO) {
            executeJson("$base/api/v1/agent/jobs/$jobId/complete", token, jobToken, "{}")
        }

    suspend fun fail(token: String, jobId: String, jobToken: String, error: String) =
        withContext(Dispatchers.IO) {
            val body = JSONObject().put("error", error).toString()
            executeJson("$base/api/v1/agent/jobs/$jobId/fail", token, jobToken, body)
        }

    fun postChunkBlocking(token: String, jobId: String, index: Int, jobToken: String, bytes: ByteArray): JSONObject {
        val req = Request.Builder()
            .url("$base/api/v1/agent/jobs/$jobId/chunks/$index")
            .header("Authorization", "Bearer $token")
            .header("x-job-token", jobToken)
            .post(bytes.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        val resp = client.newCall(req).execute()
        resp.use {
            val text = it.body?.string() ?: ""
            if (!it.isSuccessful) throw apiError(it.code, text)
            return JSONObject(text)
        }
    }

    fun getChunkBlocking(token: String, jobId: String, index: Int, jobToken: String): Chunk {
        val req = Request.Builder()
            .url("$base/api/v1/agent/jobs/$jobId/chunks/$index")
            .header("Authorization", "Bearer $token")
            .header("x-job-token", jobToken)
            .get()
            .build()
        val resp = client.newCall(req).execute()
        resp.use {
            val bytes = it.body?.bytes() ?: ByteArray(0)
            if (!it.isSuccessful) throw apiError(it.code, String(bytes))
            return Chunk(
                bytes,
                it.header("X-Chunk-Start")?.toLongOrNull() ?: 0L,
                it.header("X-Chunk-End")?.toLongOrNull() ?: 0L,
                it.header("X-Total-Bytes")?.toLongOrNull() ?: 0L
            )
        }
    }

    private fun executeJson(url: String, token: String?, jobToken: String?, jsonBody: String): JSONObject {
        val builder = Request.Builder().url(url)
        if (token != null) builder.header("Authorization", "Bearer $token")
        if (jobToken != null) builder.header("x-job-token", jobToken)
        val req = builder
            .post(jsonBody.toRequestBody("application/json".toMediaType()))
            .build()
        val resp = client.newCall(req).execute()
        resp.use {
            val text = it.body?.string() ?: ""
            if (!it.isSuccessful) throw apiError(it.code, text)
            return JSONObject(text)
        }
    }

    private fun apiError(code: Int, body: String): ApiException {
        val msg = try {
            val j = JSONObject(body)
            if (j.has("error")) j.optString("error") else "HTTP $code"
        } catch (e: Exception) {
            "HTTP $code"
        }
        return ApiException(code, msg)
    }

    private fun parseJobs(arr: JSONArray?): List<AgentJob> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            AgentJob(
                jobId = o.optString("job_id"),
                direction = o.optString("direction"),
                totalBytes = o.optLong("total_bytes"),
                bytesDone = o.optLong("bytes_done"),
                chunkSize = o.optLong("chunk_size"),
                itemId = o.optString("item_id"),
                sha256 = if (o.isNull("sha256")) null else o.optString("sha256"),
                jobToken = o.optString("job_token"),
                nodeId = o.optString("node_id"),
                nodeName = if (o.isNull("node_name")) null else o.optString("node_name")
            )
        }
    }
}
