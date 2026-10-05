package com.matheus.parakeetstt;

import java.io.File;

import com.k2fsa.sherpa.onnx.FeatureConfig;
import com.k2fsa.sherpa.onnx.OfflineModelConfig;
import com.k2fsa.sherpa.onnx.OfflineRecognizer;
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig;
import com.k2fsa.sherpa.onnx.OfflineStream;
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig;

/**
 * Lazily-built sherpa-onnx offline recognizer for Parakeet TDT (NeMo transducer).
 * Not thread-safe by itself: the plugin calls it from a single worker thread.
 *
 * Runs on CPU. The published sherpa-onnx AAR is built without QNN
 * (-DSHERPA_ONNX_ENABLE_QNN=OFF), so the Snapdragon NPU path is not available
 * with it — see plugins/parakeet-stt/README.md.
 */
final class Transcriber {

    static final int SAMPLE_RATE = 16000;

    private OfflineRecognizer recognizer;

    synchronized String transcribe(File modelDir, float[] samples) {
        OfflineRecognizer r = ensure(modelDir);
        OfflineStream stream = r.createStream();
        try {
            stream.acceptWaveform(samples, SAMPLE_RATE);
            r.decode(stream);
            String text = r.getResult(stream).getText();
            return text == null ? "" : text.trim();
        } finally {
            stream.release();
        }
    }

    synchronized void release() {
        if (recognizer != null) {
            recognizer.release();
            recognizer = null;
        }
    }

    private OfflineRecognizer ensure(File dir) {
        if (recognizer != null) return recognizer;

        OfflineTransducerModelConfig transducer = new OfflineTransducerModelConfig();
        transducer.setEncoder(new File(dir, "encoder.int8.onnx").getAbsolutePath());
        transducer.setDecoder(new File(dir, "decoder.int8.onnx").getAbsolutePath());
        transducer.setJoiner(new File(dir, "joiner.int8.onnx").getAbsolutePath());

        OfflineModelConfig model = new OfflineModelConfig();
        model.setTransducer(transducer);
        model.setTokens(new File(dir, "tokens.txt").getAbsolutePath());
        model.setModelType("nemo_transducer");
        model.setProvider("cpu");
        model.setNumThreads(Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors())));
        model.setDebug(false);

        FeatureConfig feat = new FeatureConfig();
        feat.setSampleRate(SAMPLE_RATE);
        // feature_dim is overridden from the model metadata by sherpa-onnx's NeMo transducer impl.

        OfflineRecognizerConfig config = new OfflineRecognizerConfig();
        config.setFeatConfig(feat);
        config.setModelConfig(model);
        config.setDecodingMethod("greedy_search");

        // null AssetManager → the recognizer loads the model from absolute file paths.
        recognizer = new OfflineRecognizer(null, config);
        return recognizer;
    }
}
