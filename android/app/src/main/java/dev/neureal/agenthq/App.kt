package dev.neureal.agenthq

import android.app.Application
import java.io.File

// Any uncaught crash is written to files/last-crash.txt before the process
// dies; the Link tab surfaces it so bug reports carry the actual stack.
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                File(filesDir, "last-crash.txt").writeText(
                    "${java.util.Date()}\nthread: ${thread.name}\n${android.util.Log.getStackTraceString(throwable)}",
                )
            } catch (ignored: Exception) {
            }
            previous?.uncaughtException(thread, throwable)
        }
    }

    companion object {
        fun lastCrash(context: android.content.Context): String? {
            val file = File(context.filesDir, "last-crash.txt")
            return if (file.exists()) file.readText().take(4000) else null
        }

        fun clearCrash(context: android.content.Context) {
            File(context.filesDir, "last-crash.txt").delete()
        }
    }
}
