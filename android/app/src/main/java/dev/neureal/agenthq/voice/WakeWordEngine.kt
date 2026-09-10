package dev.neureal.agenthq.voice

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.io.InputStream
import java.nio.FloatBuffer

// openWakeWord "hey jarvis" pipeline (Apache-2.0 models, fully offline),
// mirroring openwakeword/utils.py `_streaming_features` exactly:
//   80ms chunks of int16 @16kHz (as float32) + 480-sample lookback
//     -> melspectrogram.onnx -> squeeze -> x/10 + 2
//   mel buffer (init: 76 rows of ones) -> last-76-frame window, one step of 8
//     per 1280-sample block -> embedding_model.onnx [1,76,32,1] -> 96 floats
//   last 16 embeddings [1,16,96] -> hey_jarvis onnx -> sigmoid score.
// Pure JVM (no Android imports) so it is unit-tested against synthesized
// audio before it ever runs on a phone.
class WakeWordEngine(
    melspecModel: ByteArray,
    embeddingModel: ByteArray,
    wakeModel: ByteArray,
    private val threshold: Float = 0.5f,
    private val refractoryChunks: Int = 25, // ~2s of suppression after a hit
) {
    companion object {
        const val CHUNK_SAMPLES = 1280 // 80ms @ 16kHz
        private const val LOOKBACK = 480 // 160 * 3, per the reference
        private const val MEL_WINDOW = 76
        private const val MEL_BINS = 32
        private const val EMB_WINDOW = 16
        private const val MEL_MAX = 970
        private const val EMB_MAX = 120

        fun fromStreams(mel: InputStream, emb: InputStream, wake: InputStream): WakeWordEngine =
            WakeWordEngine(mel.readBytes(), emb.readBytes(), wake.readBytes())
    }

    private val env = OrtEnvironment.getEnvironment()
    private val mel: OrtSession = env.createSession(melspecModel, OrtSession.SessionOptions())
    private val emb: OrtSession = env.createSession(embeddingModel, OrtSession.SessionOptions())
    private val wake: OrtSession = env.createSession(wakeModel, OrtSession.SessionOptions())
    private val melInput = mel.inputNames.first()
    private val embInput = emb.inputNames.first()
    private val wakeInput = wake.inputNames.first()

    private val melBuffer = ArrayDeque<FloatArray>().apply { repeat(MEL_WINDOW) { add(FloatArray(MEL_BINS) { 1f }) } }
    private val embBuffer = ArrayDeque<FloatArray>()
    private var lookbackTail = ShortArray(0)
    private var cooldown = 0

    /** Feed exactly one 80ms chunk (1280 samples). Returns the current score. */
    @Synchronized
    fun processChunk(samples: ShortArray): Float {
        require(samples.size == CHUNK_SAMPLES) { "feed exactly $CHUNK_SAMPLES samples" }

        // Mel over lookback + chunk (raw int16 values as float32, per reference).
        val melIn = FloatArray(lookbackTail.size + samples.size)
        for (i in lookbackTail.indices) melIn[i] = lookbackTail[i].toFloat()
        for (i in samples.indices) melIn[lookbackTail.size + i] = samples[i].toFloat()
        val melFrames = runMel(melIn)
        for (frame in melFrames) {
            melBuffer.addLast(frame)
            if (melBuffer.size > MEL_MAX) melBuffer.removeFirst()
        }
        val tailLength = minOf(LOOKBACK, samples.size)
        lookbackTail = samples.copyOfRange(samples.size - tailLength, samples.size)

        // One embedding per processed block: the last 76 mel frames.
        if (melBuffer.size >= MEL_WINDOW) {
            val window = melBuffer.toList().takeLast(MEL_WINDOW)
            embBuffer.addLast(runEmbedding(window))
            if (embBuffer.size > EMB_MAX) embBuffer.removeFirst()
        }

        if (embBuffer.size < EMB_WINDOW) return 0f
        val score = runWake(embBuffer.toList().takeLast(EMB_WINDOW))
        if (cooldown > 0) {
            cooldown -= 1
            return 0f
        }
        if (score >= threshold) cooldown = refractoryChunks
        return score
    }

    fun isWake(score: Float): Boolean = score >= threshold

    private fun runMel(input: FloatArray): List<FloatArray> {
        OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, input.size.toLong())).use { tensor ->
            mel.run(mapOf(melInput to tensor)).use { result ->
                val flat = flatten(result[0].value)
                val frames = flat.size / MEL_BINS
                return (0 until frames).map { f ->
                    FloatArray(MEL_BINS) { b -> flat[f * MEL_BINS + b] / 10f + 2f }
                }
            }
        }
    }

    private fun runEmbedding(window: List<FloatArray>): FloatArray {
        val input = FloatArray(MEL_WINDOW * MEL_BINS)
        for (f in 0 until MEL_WINDOW) window[f].copyInto(input, f * MEL_BINS)
        OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(input),
            longArrayOf(1, MEL_WINDOW.toLong(), MEL_BINS.toLong(), 1),
        ).use { tensor ->
            emb.run(mapOf(embInput to tensor)).use { result ->
                return flatten(result[0].value)
            }
        }
    }

    private fun runWake(embeddings: List<FloatArray>): Float {
        val width = embeddings[0].size
        val input = FloatArray(EMB_WINDOW * width)
        for (i in 0 until EMB_WINDOW) embeddings[i].copyInto(input, i * width)
        OnnxTensor.createTensor(
            env,
            FloatBuffer.wrap(input),
            longArrayOf(1, EMB_WINDOW.toLong(), width.toLong()),
        ).use { tensor ->
            wake.run(mapOf(wakeInput to tensor)).use { result ->
                return flatten(result[0].value).firstOrNull() ?: 0f
            }
        }
    }

    // ORT returns nested arrays whose depth depends on the model output rank.
    private fun flatten(value: Any?): FloatArray = when (value) {
        is FloatArray -> value
        is Array<*> -> {
            val parts = value.map { flatten(it) }
            val out = FloatArray(parts.sumOf { it.size })
            var offset = 0
            for (part in parts) {
                part.copyInto(out, offset)
                offset += part.size
            }
            out
        }
        else -> FloatArray(0)
    }
}
