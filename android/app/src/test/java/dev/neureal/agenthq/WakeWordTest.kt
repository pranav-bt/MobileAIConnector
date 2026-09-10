package dev.neureal.agenthq

import dev.neureal.agenthq.voice.WakeWordEngine
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Runs the real openWakeWord pipeline over synthesized speech: "hey jarvis"
// must score high, unrelated speech and silence must not. Models load from
// the app's assets; audio clips are Windows-TTS-generated 16kHz mono PCM.
class WakeWordTest {

    private fun assetsDir(): File {
        // Unit tests run with cwd = the app module; assets sit in src/main.
        val candidates = listOf(File("src/main/assets/oww"), File("app/src/main/assets/oww"))
        return candidates.firstOrNull { it.exists() } ?: error("oww assets not found")
    }

    private fun engine(): WakeWordEngine {
        val dir = assetsDir()
        return WakeWordEngine(
            File(dir, "melspectrogram.onnx").readBytes(),
            File(dir, "embedding_model.onnx").readBytes(),
            File(dir, "hey_jarvis_v0.1.onnx").readBytes(),
        )
    }

    private fun readWavSamples(resource: String): ShortArray {
        val bytes = javaClass.getResourceAsStream("/$resource")?.readBytes() ?: error("$resource missing")
        // Find the 'data' chunk rather than assuming a 44-byte header.
        var offset = 12
        while (offset + 8 <= bytes.size) {
            val id = String(bytes, offset, 4, Charsets.US_ASCII)
            val size = ByteBuffer.wrap(bytes, offset + 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
            if (id == "data") {
                val samples = ShortArray(size / 2)
                ByteBuffer.wrap(bytes, offset + 8, size).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples)
                return samples
            }
            offset += 8 + size + (size and 1)
        }
        error("no data chunk in $resource")
    }

    // Warm up with leading silence, stream in 80ms chunks, return the max score.
    private fun maxScore(engine: WakeWordEngine, samples: ShortArray): Float {
        val silence = ShortArray(16000 * 2) // 2s: fills the embedding window
        val audio = silence + samples + ShortArray(16000)
        var max = 0f
        var index = 0
        while (index + WakeWordEngine.CHUNK_SAMPLES <= audio.size) {
            val chunk = audio.copyOfRange(index, index + WakeWordEngine.CHUNK_SAMPLES)
            val score = engine.processChunk(chunk)
            if (score > max) max = score
            index += WakeWordEngine.CHUNK_SAMPLES
        }
        return max
    }

    @Test
    fun `hey jarvis triggers, other speech and silence do not`() {
        val positive = maxScore(engine(), readWavSamples("hey_jarvis.wav"))
        val negative = maxScore(engine(), readWavSamples("negative.wav"))
        val silence = maxScore(engine(), ShortArray(16000 * 3))

        println("scores — hey_jarvis: $positive · other speech: $negative · silence: $silence")
        assertTrue("'hey jarvis' should trigger (score $positive)", positive >= 0.5f)
        assertTrue("unrelated speech must stay low (score $negative)", negative < 0.3f)
        assertTrue("silence must stay low (score $silence)", silence < 0.1f)
    }
}
