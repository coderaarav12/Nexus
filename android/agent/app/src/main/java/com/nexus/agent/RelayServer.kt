package com.nexus.agent

import kotlinx.coroutines.delay
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

class RelayServer(
    private val api: ServerApi,
    private val prefs: Prefs,
    private val log: LogBuffer
) {

    class DownloadMeta(
        val chunkSize: Long,
        val totalBytes: Long,
        val jobToken: String,
        val dir: File
    )

    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null

    private val executor = Executors.newCachedThreadPool { r ->
        Thread(r, "nexus-relay").apply { isDaemon = true }
    }

    private val uploadBytes = ConcurrentHashMap<String, Long>()
    private val downloadServed = ConcurrentHashMap<String, Int>()
    private val downloads = ConcurrentHashMap<String, DownloadMeta>()

    private val chunkPath = Regex("^/relay/v1/jobs/([^/]+)/chunks/(\\d+)$")

    fun isRunning(): Boolean = serverSocket != null && !(serverSocket?.isClosed ?: true)

    fun start() {
        if (serverSocket != null) return
        val ss = ServerSocket(RELAY_PORT, 0, java.net.InetAddress.getByName("0.0.0.0"))
        serverSocket = ss
        acceptThread = Thread({
            while (!ss.isClosed) {
                try {
                    val client = ss.accept()
                    executor.submit { handleClient(client) }
                } catch (e: Exception) {
                    if (!ss.isClosed) log.log("Relay accept error: ${e.message}")
                }
            }
        }, "nexus-relay-accept").apply { isDaemon = true; start() }
        log.log("Relay listening on 0.0.0.0:$RELAY_PORT")
    }

    fun stop() {
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        acceptThread = null
        uploadBytes.clear()
        downloadServed.clear()
        downloads.clear()
    }

    fun registerDownload(jobId: String, meta: DownloadMeta) {
        downloads[jobId] = meta
    }

    fun clearJob(jobId: String) {
        uploadBytes.remove(jobId)
        downloadServed.remove(jobId)
        downloads.remove(jobId)
    }

    suspend fun awaitUpload(jobId: String, totalBytes: Long) {
        val deadline = System.currentTimeMillis() + JOB_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if ((uploadBytes[jobId] ?: 0L) >= totalBytes) return
            delay(500)
        }
        throw IllegalStateException("upload stalled for 10 minutes")
    }

    suspend fun awaitDownloadServed(jobId: String, lastIndex: Int) {
        val deadline = System.currentTimeMillis() + JOB_TIMEOUT_MS
        while (System.currentTimeMillis() < deadline) {
            if ((downloadServed[jobId] ?: -1) >= lastIndex) return
            delay(500)
        }
        throw IllegalStateException("download not served for 10 minutes")
    }

    private fun handleClient(socket: Socket) {
        try {
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1]

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) {
                    headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                }
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = if (contentLength > 0) {
                val buf = ByteArray(contentLength)
                var read = 0
                val input = socket.getInputStream()
                while (read < contentLength) {
                    val n = input.read(buf, read, contentLength - read)
                    if (n < 0) break
                    read += n
                }
                buf
            } else ByteArray(0)

            when (method) {
                "POST" -> handlePost(socket, path, headers, body)
                "GET" -> handleGet(socket, path, headers)
                else -> writeJson(socket, 404, jsonError("not found"))
            }
        } catch (e: Exception) {
            try { writeJson(socket, 500, jsonError(e.message ?: "internal error")) } catch (_: Exception) {}
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun handlePost(socket: Socket, path: String, headers: Map<String, String>, body: ByteArray) {
        val m = chunkPath.matchEntire(path) ?: return writeJson(socket, 404, jsonError("not found"))
        val jobId = m.groupValues[1]
        val index = m.groupValues[2].toInt()
        val jobToken = headers["x-job-token"]
        if (jobToken.isNullOrEmpty()) return writeJson(socket, 401, jsonError("missing x-job-token"))
        val agentToken = prefs.getToken()
        if (agentToken.isNullOrEmpty()) return writeJson(socket, 401, jsonError("agent not registered"))
        val result = try {
            api.postChunkBlocking(agentToken, jobId, index, jobToken, body)
        } catch (e: ServerApi.ApiException) {
            return writeJson(socket, e.code, jsonError(e.message ?: "upstream error"))
        } catch (e: Exception) {
            return writeJson(socket, 502, jsonError(e.message ?: "upstream error"))
        }
        uploadBytes[jobId] = result.optLong("bytesDone", result.optLong("bytes_done", 0L))
        writeJson(socket, 200, result.toString())
    }

    private fun handleGet(socket: Socket, path: String, headers: Map<String, String>) {
        val m = chunkPath.matchEntire(path) ?: return writeJson(socket, 404, jsonError("not found"))
        val jobId = m.groupValues[1]
        val index = m.groupValues[2].toInt()
        val jobToken = headers["x-job-token"]
        if (jobToken.isNullOrEmpty()) return writeJson(socket, 401, jsonError("missing x-job-token"))
        val meta = downloads[jobId]
        if (meta == null) return writeJson(socket, 404, jsonError("download job not claimed"))
        val agentToken = prefs.getToken()
        if (agentToken.isNullOrEmpty()) return writeJson(socket, 401, jsonError("agent not registered"))
        val file = File(meta.dir, index.toString())
        val bytes = if (file.isFile && file.length() > 0) {
            file.readBytes()
        } else {
            val chunk = try {
                api.getChunkBlocking(agentToken, jobId, index, jobToken)
            } catch (e: ServerApi.ApiException) {
                return writeJson(socket, e.code, jsonError(e.message ?: "upstream error"))
            } catch (e: Exception) {
                return writeJson(socket, 502, jsonError(e.message ?: "upstream error"))
            }
            file.parentFile?.mkdirs()
            file.writeBytes(chunk.bytes)
            chunk.bytes
        }
        downloadServed[jobId] = maxOf(downloadServed[jobId] ?: -1, index)
        val start = index.toLong() * meta.chunkSize
        val end = start + bytes.size - 1
        val responseHeaders = buildString {
            append("HTTP/1.1 200 OK\r\n")
            append("Content-Type: application/octet-stream\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("X-Chunk-Start: $start\r\n")
            append("X-Chunk-End: $end\r\n")
            append("X-Total-Bytes: ${meta.totalBytes}\r\n")
            append("\r\n")
        }
        val output = socket.getOutputStream()
        output.write(responseHeaders.toByteArray(Charsets.UTF_8))
        output.write(bytes)
        output.flush()
    }

    private fun writeJson(socket: Socket, status: Int, json: String) {
        val bytes = json.toByteArray(Charsets.UTF_8)
        val statusText = when (status) {
            200 -> "OK"
            401 -> "Unauthorized"
            404 -> "Not Found"
            500 -> "Internal Server Error"
            502 -> "Bad Gateway"
            else -> "Error"
        }
        val response = buildString {
            append("HTTP/1.1 $status $statusText\r\n")
            append("Content-Type: application/json\r\n")
            append("Content-Length: ${bytes.size}\r\n")
            append("\r\n")
        }
        val output = socket.getOutputStream()
        output.write(response.toByteArray(Charsets.UTF_8))
        output.write(bytes)
        output.flush()
    }

    private fun jsonError(msg: String): String =
        "{\"error\":\"${msg.replace("\\", "\\\\").replace("\"", "\\\"")}\"}"

    companion object {
        const val RELAY_PORT = 9123
        const val JOB_TIMEOUT_MS = 10 * 60 * 1000L
        private const val JOB_TOKEN_HEADER = "x-job-token"
    }
}
