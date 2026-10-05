package com.matheus.parakeetstt;

import android.os.Build;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * On-device speech-to-text: Parakeet TDT 0.6B v3 (int8) on sherpa-onnx, CPU.
 *
 * JS API (window.Capacitor.nativePromise('ParakeetStt', …)):
 *   status()                 → { installed, installing, progress, device, soc, npu, npuReason, model, bytes }
 *   install()                → resolves when done; emits "progress" { received, total, percent }
 *   cancel()                 → aborts a running install
 *   remove()                 → deletes the model from internal storage
 *   transcribe({ pcm })      → { text, ms, device }; pcm = base64 of little-endian Float32 samples, 16 kHz mono
 */
@CapacitorPlugin(name = "ParakeetStt")
public class ParakeetSttPlugin extends Plugin {

    /** Upper bound on one dictation: 10 min at 16 kHz (the WebView JSON bridge is the real limit). */
    private static final int MAX_SAMPLES = 16000 * 600;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Transcriber transcriber = new Transcriber();
    private ModelInstaller installer;
    private volatile boolean installing;
    private volatile int progress;

    @Override
    public void load() {
        installer = new ModelInstaller(getContext().getFilesDir());
    }

    @PluginMethod
    public void status(PluginCall call) {
        boolean installed = installer.isInstalled();
        JSObject r = new JSObject();
        r.put("installed", installed);
        r.put("installing", installing);
        r.put("progress", progress);
        r.put("device", "cpu");
        r.put("soc", socName());
        r.put("npu", false);
        r.put("npuReason", "O sherpa-onnx publicado (AAR) é compilado sem QNN; a NPU exige build próprio com o SDK da Qualcomm.");
        r.put("model", ModelInstaller.MODEL_NAME);
        r.put("bytes", installed ? installer.installedBytes() : 0);
        call.resolve(r);
    }

    @PluginMethod
    public void install(PluginCall call) {
        if (installer.isInstalled()) {
            call.resolve(new JSObject().put("installed", true));
            return;
        }
        synchronized (this) {
            if (installing) {
                call.reject("Instalação já em andamento.", "BUSY");
                return;
            }
            installing = true;
            progress = 0;
        }
        new Thread(() -> {
            try {
                installer.install((received, total) -> {
                    int pct = total > 0 ? (int) Math.min(100, received * 100 / total) : 0;
                    progress = pct;
                    JSObject ev = new JSObject();
                    ev.put("received", received);
                    ev.put("total", total);
                    ev.put("percent", pct);
                    notifyListeners("progress", ev);
                });
                progress = 100;
                call.resolve(new JSObject().put("installed", true));
            } catch (Throwable t) {
                call.reject(message(t, "Falha ao instalar o modelo."), "INSTALL_FAILED");
            } finally {
                installing = false;
            }
        }, "parakeet-install").start();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        installer.cancel();
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        if (installing) {
            call.reject("Cancele a instalação antes de remover.", "BUSY");
            return;
        }
        worker.execute(() -> {
            transcriber.release();
            installer.remove();
            progress = 0;
            call.resolve();
        });
    }

    @PluginMethod
    public void transcribe(PluginCall call) {
        String pcm = call.getString("pcm");
        if (pcm == null || pcm.isEmpty()) {
            call.reject("Áudio vazio.", "BAD_INPUT");
            return;
        }
        if (!installer.isInstalled()) {
            call.reject("Modelo de voz não instalado.", "NOT_INSTALLED");
            return;
        }
        worker.execute(() -> {
            try {
                float[] samples = decodePcm(pcm);
                long t0 = System.nanoTime();
                String text = transcriber.transcribe(installer.modelDir(), samples);
                JSObject r = new JSObject();
                r.put("text", text);
                r.put("ms", (System.nanoTime() - t0) / 1_000_000);
                r.put("device", "cpu");
                call.resolve(r);
            } catch (Throwable t) {
                // Includes UnsatisfiedLinkError (unsupported ABI) and OOM: the web client falls back to the PC.
                transcriber.release();
                call.reject(message(t, "Falha na transcrição local."), "TRANSCRIBE_FAILED");
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        installer.cancel();
        worker.execute(transcriber::release);
        worker.shutdown();
    }

    private static float[] decodePcm(String b64) {
        byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
        if (bytes.length % 4 != 0) throw new IllegalArgumentException("PCM inválido (esperado Float32).");
        int n = bytes.length / 4;
        if (n == 0 || n > MAX_SAMPLES) throw new IllegalArgumentException("Duração de áudio fora do limite.");
        float[] out = new float[n];
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(out);
        return out;
    }

    private static String socName() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            String m = Build.SOC_MANUFACTURER, model = Build.SOC_MODEL;
            if (model != null && !model.isEmpty() && !Build.UNKNOWN.equals(model)) return m + " " + model;
        }
        return Build.HARDWARE;
    }

    private static String message(Throwable t, String fallback) {
        String m = t.getMessage();
        return m == null || m.isEmpty() ? fallback : m;
    }
}
