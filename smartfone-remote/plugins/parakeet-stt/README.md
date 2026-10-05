# parakeet-stt (plugin Capacitor local)

Ditado no próprio celular com **Parakeet TDT 0.6B v3** (multilíngue, int8) sobre o
**sherpa-onnx 1.13.8** (AAR oficial, baixado no build e conferido por SHA-256).
O modelo (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, 487 MB compactado) não vai no
APK: é baixado do release `asr-models` do sherpa-onnx, conferido por SHA-256 e
descompactado em `filesDir/parakeet/`. Uso pelo web client: `www/localStt.js`.

## NPU (Snapdragon / QNN): não habilitada — verificação

- A AAR publicada é compilada **sem QNN**: `libsherpa-onnx-jni.so` contém
  "Please rebuild sherpa-onnx with -DSHERPA_ONNX_ENABLE_QNN=ON if you want to use qnn".
  Nenhum release (v1.13.5–v1.13.8) publica runtime QNN para Android (AAR ou libs).
- Os modelos existem: release `asr-models-qnn-binary-2` traz context binaries
  `sherpa-onnx-qnn-<SoC>-binary-parakeet-tdt-0.6b-v3-<N>s-transducer` para SM8450,
  SM8475, SM8550, SM8650, SM8750, SM8850 (e QCS9100, SA8255, SA8295), com janela fixa
  de 3 s a 30 s e ~440 MB cada.
- Usá-los exige compilar o sherpa-onnx com o QNN SDK da Qualcomm e empacotar
  `libQnnHtp.so`, `libQnnSystem.so` e `libQnnHtpV*Stub/Skel.so` (proprietárias):
  https://k2-fsa.github.io/sherpa/onnx/qnn/build.html ,
  https://k2-fsa.github.io/sherpa/onnx/qnn/build-android-demo.html
- Os APKs QNN pré-compilados não incluem Parakeet:
  https://k2-fsa.github.io/sherpa/onnx/android/apk-qnn-simulate-streaming-asr.html

Por isso o plugin roda em CPU e só informa o SoC em `status()`.
