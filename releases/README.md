# RIVET 0.1.0 local installation

This folder contains the built Linux runtime, its SHA-256 checksum and standalone installers. Keep `install-rivet-termux.sh` beside `rivet-0.1.0-linux.tar.gz` and `rivet-0.1.0-linux.tar.gz.sha256`. Obtain all three from a trusted source. This is a local development release; it has not been publicly published.

## Current Fold5

Use the existing Ubuntu studio. In Termux:

```sh
~/start-rivet
```

Open `http://127.0.0.1:8787/` in Android Chrome on that phone. It works locally without internet after prerequisites are installed. Grant camera/microphone permission when using those sources. Keep Termux and the browser running during production.

## New Ubuntu or compatible Linux installation

Requires Python 3.10+, Bash and a compatible browser. FFmpeg with libx264/AAC enables conversion and streaming. Use an empty target directory:

```sh
sha256sum -c rivet-0.1.0-linux.tar.gz.sha256
tar -xzf rivet-0.1.0-linux.tar.gz -C "$HOME"
bash "$HOME/rivet/launch.sh"
```

Then open `http://127.0.0.1:8787/` on that same machine. No Node.js installation is needed to run the packaged app.

## New Android/Termux installation

In a Termux-readable directory containing these files:

```sh
bash ./install-rivet-termux.sh --launch
```

Install Termux first. Internet is needed once for any missing Termux/Ubuntu prerequisites; the installer then adds Ubuntu, Python, FFmpeg, RIVET, `~/start-rivet`, and the Termux:Widget shortcut files. After setup, local production and transcoding work offline. This first-install command refuses to replace an existing studio. It does not enable a device-specific Android encoder automatically. The tested Fold5 adapter is documented in the source README; other phones and sustained performance still need validation.

The full runtime README and verification notes are under `rivet/` in the source repository.
