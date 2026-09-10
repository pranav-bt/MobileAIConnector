package dev.neureal.agenthq.store

import android.content.Context

// Tiny key-value seam so the link stack (pairing, session, identity) runs
// identically on-device and in JVM tests.
interface KV {
    fun get(key: String): String?
    fun put(vararg pairs: Pair<String, String>)
    fun clear()
}

class PrefsKV(context: Context, name: String) : KV {
    private val prefs = context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(vararg pairs: Pair<String, String>) {
        val editor = prefs.edit()
        for ((key, value) in pairs) editor.putString(key, value)
        editor.apply()
    }
    override fun clear() {
        prefs.edit().clear().apply()
    }
}

class MemoryKV : KV {
    private val map = LinkedHashMap<String, String>()
    override fun get(key: String): String? = synchronized(map) { map[key] }
    override fun put(vararg pairs: Pair<String, String>) = synchronized(map) { map.putAll(pairs) }
    override fun clear() = synchronized(map) { map.clear() }
}
