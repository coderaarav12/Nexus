package com.nexus.agent

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.File
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicInteger

interface RelayWakelock {
    fun acquire()
    fun release()
}

class JobRunner(
    private val api: ServerApi,
    private val prefs: Prefs,
    private val cacheDir: File,
    private val relay: RelayServer,
    private val wakelock: RelayWakelock,
    private val log: LogBuffer
) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val queue = ArrayDeque<AgentJob>()
    private val active = AtomicInteger(0)

    fun activeCount(): Int = active.get()

    fun enqueue(jobs: List<AgentJob>) {
        if (jobs.isEmpty()) return
        synchronized(queue) {
            for (job in jobs) {
                if (queue.none { it.jobId == job.jobId }) queue.addLast(job)
            }
        }
        kick()
    }

    fun kick() {
        scope.launch {
            mutex.withLock { pump() }
        }
    }

    private suspend fun pump() {
        while (true) {
            val job = synchronized(queue) { queue.pollFirst() } ?: break
            active.incrementAndGet()
            try {
                process(job)
            } catch (e: Exception) {
                log.log("job ${job.jobId} crashed: ${e.message}")
            } finally {
                active.decrementAndGet()
            }
        }
    }

    private suspend fun process(job: AgentJob) {
        val token = prefs.getToken() ?: return
        val claim = api.claim(token, job.jobId)
        if (claim.status != "running") {
            log.log("job ${job.jobId}: status ${claim.status}, skipped")
            return
        }
        val claimed = claim.job ?: return
        val direction = claimed.optString("direction", job.direction)
        if (direction == "download") {
            processDownload(token, job, claimed)
        } else {
            processUpload(token, job, claimed)
        }
    }

    private suspend fun processUpload(token: String, job: AgentJob, claimed: JSONObject) {
        val jobId = job.jobId
        val totalBytes = claimed.optLong("total_bytes", job.totalBytes)
        val jobToken = claimed.optString("job_token", job.jobToken)
        log.log("upload job $jobId started ($totalBytes bytes)")
        wakelock.acquire()
        try {
            relay.awaitUpload(jobId, totalBytes)
            api.complete(token, jobId, jobToken)
            log.log("upload job $jobId completed")
        } catch (e: Exception) {
            failJob(jobId, jobToken, e.message ?: "failed")
        } finally {
            wakelock.release()
            relay.clearJob(jobId)
            prefs.clearJobProgress(jobId)
        }
    }

    private suspend fun processDownload(token: String, job: AgentJob, claimed: JSONObject) {
        val jobId = job.jobId
        val totalBytes = claimed.optLong("total_bytes", job.totalBytes)
        val chunkSize = claimed.optLong("chunk_size", job.chunkSize)
        val jobToken = claimed.optString("job_token", job.jobToken)
        val numChunks = if (chunkSize > 0) ((totalBytes + chunkSize - 1) / chunkSize).toInt() else 0
        val dir = File(cacheDir, "relay/$jobId").apply { mkdirs() }
        relay.registerDownload(jobId, RelayServer.DownloadMeta(chunkSize, totalBytes, jobToken, dir))
        log.log("download job $jobId started ($totalBytes bytes, $numChunks chunks)")
        wakelock.acquire()
        try {
            var fetched = prefs.getDownloadProgress(jobId)
            if (fetched > numChunks) fetched = 0
            var index = fetched
            while (index < numChunks) {
                val file = File(dir, index.toString())
                if (file.isFile && file.length() > 0) {
                    index++
                    continue
                }
                val chunk = api.getChunk(token, jobId, index, jobToken)
                file.writeBytes(chunk.bytes)
                index++
                prefs.setDownloadProgress(jobId, index)
            }
            log.log("download job $jobId: $numChunks chunks prefetched")
            relay.awaitDownloadServed(jobId, numChunks - 1)
            api.complete(token, jobId, jobToken)
            log.log("download job $jobId completed")
        } catch (e: Exception) {
            failJob(jobId, jobToken, e.message ?: "failed")
        } finally {
            wakelock.release()
            relay.clearJob(jobId)
            prefs.clearJobProgress(jobId)
        }
    }

    private suspend fun failJob(jobId: String, jobToken: String, error: String) {
        log.log("job $jobId failed: $error")
        val token = prefs.getToken() ?: return
        try {
            api.fail(token, jobId, jobToken, error)
        } catch (e: Exception) {
            log.log("could not mark job $jobId failed: ${e.message}")
        }
    }
}
