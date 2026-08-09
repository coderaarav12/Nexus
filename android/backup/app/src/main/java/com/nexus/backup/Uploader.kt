package com.nexus.backup

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import java.io.InputStream
import java.security.MessageDigest
import org.json.JSONObject

sealed class UploadOutcome {
    object Done : UploadOutcome()
    data class Skipped(val reason: String) : UploadOutcome()
    data class Failed(val message: String) : UploadOutcome()
}

class Uploader(context: Context, private val api: ServerApi) {

    private val appContext = context.applicationContext
    private val sp: SharedPreferences =
        appContext.getSharedPreferences("nexus_upload_state", Context.MODE_PRIVATE)

    fun alreadyUploaded(item: MediaItem): Boolean = sp.contains(key(item))

    fun recordUploaded(item: MediaItem, sha256: String) {
        val json = JSONObject()
            .put("sha256", sha256)
            .put("size", item.size)
            .put("dateAdded", item.dateAdded)
        sp.edit().putString(key(item), json.toString()).apply()
    }

    fun upload(item: MediaItem, parentId: Long?): UploadOutcome {
        if (alreadyUploaded(item)) return UploadOutcome.Skipped("already uploaded")
        if (item.size < 1024) return UploadOutcome.Skipped("smaller than 1KB")
        val (sha, size) = sha256AndSize(item) ?: return UploadOutcome.Skipped("cannot read file")
        if (size < 1024) return UploadOutcome.Skipped("smaller than 1KB")

        return when (val jobRes = api.createUploadJob(item.displayName, size, sha, item.mtime, parentId)) {
            is ApiResult.Error -> UploadOutcome.Failed(jobRes.message)
            is ApiResult.Success -> {
                val job = jobRes.data
                if (job.deduped || job.jobId.isBlank()) {
                    recordUploaded(item, sha)
                    UploadOutcome.Done
                } else {
                    val chunkError = uploadChunks(item, job)
                    if (chunkError != null) {
                        api.failJob(job.jobId, job.jobToken, chunkError)
                        return UploadOutcome.Failed(chunkError)
                    }
                    when (val done = api.completeJob(job.jobId, job.jobToken)) {
                        is ApiResult.Error -> {
                            api.failJob(job.jobId, job.jobToken, done.message)
                            UploadOutcome.Failed(done.message)
                        }
                        is ApiResult.Success -> {
                            recordUploaded(item, sha)
                            UploadOutcome.Done
                        }
                    }
                }
            }
        }
    }

    private fun uploadChunks(item: MediaItem, job: UploadJob): String? {
        val chunkSize = job.chunkSize.toInt().coerceAtLeast(1)
        val buffer = ByteArray(chunkSize)
        var index = 0L
        var streamPos = 0L
        var stream = appContext.contentResolver.openInputStream(Uri.parse(item.uri))
            ?: return "cannot open file"
        try {
            while (true) {
                val target = index * chunkSize
                if (target != streamPos) {
                    if (target < streamPos) {
                        stream.close()
                        stream = appContext.contentResolver.openInputStream(Uri.parse(item.uri))
                            ?: return "cannot open file"
                        streamPos = 0L
                    }
                    stream.skip(target - streamPos)
                    streamPos = target
                }
                val n = readFully(stream, buffer)
                if (n < 0) break
                streamPos += n
                val slice = if (n == buffer.size) buffer else buffer.copyOf(n)
                val res = api.uploadChunk(job.jobId, job.jobToken, index, slice)
                when (res) {
                    is ApiResult.Error -> return res.message
                    is ApiResult.Success -> {
                        val r = res.data
                        index = if (r.gap || r.skipped) r.resumeIndex else index + 1
                    }
                }
            }
            return null
        } finally {
            stream.close()
        }
    }

    private fun readFully(stream: InputStream, buffer: ByteArray): Int {
        var off = 0
        while (off < buffer.size) {
            val n = stream.read(buffer, off, buffer.size - off)
            if (n < 0) return if (off == 0) -1 else off
            off += n
        }
        return off
    }

    private fun sha256AndSize(item: MediaItem): Pair<String, Long>? {
        return try {
            val input = appContext.contentResolver.openInputStream(Uri.parse(item.uri))
                ?: return null
            input.use { stream ->
                val md = MessageDigest.getInstance("SHA-256")
                val buf = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val n = stream.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                    total += n
                }
                hex(md.digest()) to total
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun hex(bytes: ByteArray): String {
        val chars = CharArray(bytes.size * 2)
        val digits = "0123456789abcdef"
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xff
            chars[i * 2] = digits[v ushr 4]
            chars[i * 2 + 1] = digits[v and 0x0f]
        }
        return String(chars)
    }

    private fun key(item: MediaItem): String = "${item.kind.name.lowercase()}:${item.id}"
}
