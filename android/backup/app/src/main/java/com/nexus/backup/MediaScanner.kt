package com.nexus.backup

import android.content.ContentUris
import android.content.ContentResolver
import android.net.Uri
import android.os.Build
import android.provider.MediaStore

data class MediaItem(
    val id: Long,
    val uri: String,
    val displayName: String,
    val size: Long,
    val dateAdded: Long,
    val dateTaken: Long,
    val dateModified: Long,
    val kind: Kind
) {
    val mtime: Long
        get() = if (dateTaken > 0) dateTaken else maxOf(dateModified * 1000, dateAdded * 1000)

    enum class Kind { PHOTO, VIDEO }
}

class MediaScanner(private val resolver: ContentResolver) {

    fun scanAll(afterDateAdded: Long): List<MediaItem> =
        scan(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, MediaItem.Kind.PHOTO, afterDateAdded) +
            scan(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, MediaItem.Kind.VIDEO, afterDateAdded)

    private fun scan(contentUri: Uri, kind: MediaItem.Kind, afterDateAdded: Long): List<MediaItem> {
        val idCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media._ID
        } else {
            MediaStore.Video.Media._ID
        }
        val nameCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media.DISPLAY_NAME
        } else {
            MediaStore.Video.Media.DISPLAY_NAME
        }
        val sizeCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media.SIZE
        } else {
            MediaStore.Video.Media.SIZE
        }
        val addedCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media.DATE_ADDED
        } else {
            MediaStore.Video.Media.DATE_ADDED
        }
        val modCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media.DATE_MODIFIED
        } else {
            MediaStore.Video.Media.DATE_MODIFIED
        }
        val takenCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media.DATE_TAKEN
        } else {
            MediaStore.Video.Media.DATE_TAKEN
        }
        val pendingCol = if (kind == MediaItem.Kind.PHOTO) {
            MediaStore.Images.Media.IS_PENDING
        } else {
            MediaStore.Video.Media.IS_PENDING
        }

        val hasPending = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        val selection = "$addedCol >= ?" + if (hasPending) " AND $pendingCol = 0" else ""
        val sortOrder = "$addedCol ASC"

        val projection = ArrayList<String>()
        projection.add(idCol)
        projection.add(nameCol)
        projection.add(sizeCol)
        projection.add(addedCol)
        projection.add(modCol)
        projection.add(takenCol)
        if (hasPending) projection.add(pendingCol)

        val out = ArrayList<MediaItem>()
        resolver.query(
            contentUri,
            projection.toTypedArray(),
            selection,
            arrayOf(afterDateAdded.toString()),
            sortOrder
        )?.use { c ->
            val iId = c.getColumnIndexOrThrow(idCol)
            val iName = c.getColumnIndexOrThrow(nameCol)
            val iSize = c.getColumnIndexOrThrow(sizeCol)
            val iAdded = c.getColumnIndexOrThrow(addedCol)
            val iMod = c.getColumnIndexOrThrow(modCol)
            val iTaken = c.getColumnIndexOrThrow(takenCol)
            while (c.moveToNext()) {
                val id = c.getLong(iId)
                val size = c.getLong(iSize)
                if (size < 0) continue
                out.add(
                    MediaItem(
                        id = id,
                        uri = ContentUris.withAppendedId(contentUri, id).toString(),
                        displayName = c.getString(iName) ?: "media_$id",
                        size = size,
                        dateAdded = c.getLong(iAdded),
                        dateTaken = c.getLong(iTaken),
                        dateModified = c.getLong(iMod),
                        kind = kind
                    )
                )
            }
        }
        return out
    }
}
